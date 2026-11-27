'use strict';

// Scheduled trigger -> pending_start -> tick hook -> run -> release, against the fake NF server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFake } = require('./fake/server');
const { VirtualClock } = require('./fake/clock');
const { NfClient } = require('../lib/nf/client');
const { Ledger } = require('../lib/ledger');
const { loadHaystackModel } = require('../lib/model');
const { buildPlan } = require('../lib/plan');
const { applyDefaults } = require('../lib/config/defaults');
const { Runner } = require('../lib/runner');
const { createSession } = require('../lib/admin');
const { readState, writeState } = require('../lib/persist');
const { readTrigger, writeTrigger, triggerFile } = require('../lib/trigger_store');
const { validateHook } = require('../lib/hooks/schema');

const LAYER = 'hpl:bacnet:1';
const NOON = Date.parse('2026-11-26T18:00:00Z');
const RULE = { kind: 'monthly_last', weekday: 3, hour: 12, minute: 0, tz: 'America/Chicago' };
const TERMINAL = ['COMPLETE', 'FAILED', 'ABORTED', 'NEEDS_ATTENTION'];

function point(equip, tags, n, writable) {
  /** @type {Record<string, string>} */
  const attrs = { equipRef: equip, class: 'point', markers: tags.join(',') };
  if (writable) attrs.writable = 'm:';
  return { uuid: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`, layer: LAYER, attrs };
}

function loadHook(name) {
  delete require.cache[require.resolve(name)];
  return require(name);
}

async function rig(options = {}) {
  const clock = new VirtualClock(options.start || NOON + 30000);
  const fake = await createFake({ clock });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  const model = loadHaystackModel({
    equipment: [{ id: 'ahu_a', type: 'ahu', tags: ['ahu'] }],
    points: [
      point('ahu_a', ['discharge', 'air', 'temp', 'sensor'], 1, false),
      point('ahu_a', ['mixed', 'air', 'temp', 'sensor'], 2, false),
      point('ahu_a', ['return', 'air', 'temp', 'sensor'], 3, false),
      point('ahu_a', ['outside', 'air', 'temp', 'sensor'], 4, false),
      point('ahu_a', ['discharge', 'air', 'pressure', 'sensor'], 5, false),
      point('ahu_a', ['fan', 'run', 'sensor'], 6, false),
      point('ahu_a', ['cool', 'valve', 'cmd'], 7, true),
      point('ahu_a', ['heat', 'valve', 'cmd'], 8, true),
      point('ahu_a', ['outside', 'damper', 'cmd'], 9, true),
    ],
  });
  /** @type {Record<string, string>} */
  const ids = {};
  for (const item of Object.values(model.equipment[0].points)) {
    const typed = /** @type {any} */ (item);
    ids[typed.role] = typed.uuid;
  }
  fake.seedAhu({ points: ids, oat: 12, rat: 24, fanOn: true });
  const config = applyDefaults({
    version: 1,
    dry_run: options.siteDryRun === true,
    write: { backend: 'nf_command', bacnet_priority: 8, command_lease_s: 300, release_retries: 0, release_backoff_s: [1] },
    plan: {
      ahu_strategy: 'per_point',
      steps: [
        { step_id: 'ahu.baseline', hold_minutes: 0 },
        { step_id: 'ahu.recirc', hold_minutes: options.holdMinutes || 0 },
        { step_id: 'ahu.economizer', enabled: false },
        { step_id: 'vav.max_cool', enabled: false },
        { step_id: 'recovery', hold_minutes: 0 },
      ],
    },
    logging: { mode: 'shadow' },
    limits: { max_total_minutes: 150, max_tick_gap_s: 3600, max_comm_failures: 3 },
  });
  const plan = buildPlan(model, config);
  const client = new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} });
  let writes = 0;
  const realWrite = client.writeInCommand.bind(client);
  client.writeInCommand = async (spec) => {
    writes += 1;
    return realWrite(spec);
  };
  const ledger = new Ledger(path.join(root, 'ledger'));
  /** @type {any[]} */
  const started = [];
  const factory = (args) => {
    started.push(args);
    const effective = args.dry_run === true ? { ...config, dry_run: true } : config;
    return new Runner({ client, ledger, config: effective, plan, model, clock, fanOnMs: 0, confirmLive: args.confirm_live === true, sleep: async () => {} });
  };
  const fire = async () => {
    const hook = loadHook('../hooks/trigger');
    const session = createSession();
    session.root = root;
    session.factory = factory;
    session.client = options.scheduleClient || client;
    session.clock = clock;
    hook.useSession(session);
    return hook({ options: { enabled: true }, globalVariables: [{ label: 'ftest_trigger_mode' }, { label: 'ftest_trigger_next' }] });
  };
  const tick = async () => {
    const hook = loadHook('../hooks/tick');
    const session = createSession();
    session.root = root;
    session.factory = factory;
    hook.useSession(session);
    await hook({ options: { enabled: true }, setGlobal() {} });
    return session;
  };
  const admin = async (action, payload) => {
    const hook = loadHook('../hooks/admin');
    const session = createSession();
    session.root = root;
    session.factory = factory;
    session.clock = clock;
    hook.useSession(session);
    return hook({ args: { action, payload: JSON.stringify(payload || {}) } });
  };
  return { clock, fake, root, client, ledger, factory, fire, tick, admin, started, writes: () => writes, model };
}

async function noActiveCommands(client) {
  const listed = await client.listCommands();
  assert.equal(listed.commands.filter((c) => String(c.name || '').startsWith('ftest-')).length, 0);
}

test('the trigger hook definition is a valid scheduled hook with DTSTART on its own line', () => {
  const doc = JSON.parse(fs.readFileSync('hooks-update/trigger.json', 'utf8'));
  assert.equal(validateHook(doc, 'scheduled').ok, true);
  assert.match(doc.hook.schedule.rrule, /^DTSTART:\d{8}T\d{6}Z\nRRULE:/);
  assert.equal(validateHook({ hook: { ...doc.hook, schedule: { rrule: 'DTSTART:x\nRRULE:A\nRRULE:B' } } }, 'scheduled').ok, false);
  assert.equal(validateHook({ hook: { ...doc.hook, schedule: { rrule: 'RRULE:A\nB' } } }, 'scheduled').ok, false);
});

test('a fresh install never starts a scheduled run', async () => {
  const r = await rig();
  try {
    const result = await r.fire();
    assert.equal(result.reason, 'disabled');
    assert.equal(result.ftest_trigger_mode, 'disabled');
    assert.equal(result.ftest_trigger_next, '');
    assert.equal(readState(r.root).pending_start, null);
    assert.equal(fs.existsSync(triggerFile(r.root)), false);
    assert.equal(readTrigger(r.root).mode, 'disabled');
  } finally {
    await r.fake.close();
  }
});

test('a dry-run trigger queues one run with zero writes, once per occurrence', async () => {
  const r = await rig();
  try {
    const saved = await r.admin('trigger', { op: 'save', rule: RULE });
    assert.equal(saved.ok, true);
    assert.equal(saved.trigger.mode, 'disabled');
    assert.equal(saved.rrule.text, 'DTSTART;TZID=America/Chicago:20260101T120000\nRRULE:FREQ=MONTHLY;BYDAY=-1TH;BYHOUR=12;BYMINUTE=0;BYSECOND=0');
    assert.equal(saved.next_runs[0].local, 'Thu 2026-12-31 12:00');
    assert.equal((await r.admin('trigger', { op: 'dry_run' })).trigger.mode, 'dry_run');
    const first = await r.fire();
    assert.equal(first.action, 'start');
    assert.equal(first.live, false);
    assert.equal(first.ftest_trigger_next, '2026-12-31T18:00:00.000Z');
    const pending = readState(r.root).pending_start;
    assert.equal(pending.live, false);
    assert.equal(pending.confirm_live, false);
    assert.equal(pending.source, 'schedule');
    assert.equal(pending.dry_run, true);
    assert.equal((await r.fire()).reason, 'already_handled');
    let phase = '';
    for (let n = 0; n < 12 && !TERMINAL.includes(phase); n += 1) phase = (await r.tick()).runner.state.phase;
    assert.equal(phase, 'COMPLETE');
    assert.equal(r.writes(), 0);
    assert.equal(r.started[0].confirm_live, false);
    await noActiveCommands(r.client);
    const view = await r.admin('trigger', { op: 'get' });
    assert.equal(view.trigger.history.length, 1);
    assert.equal(view.trigger.history[0].run_id, pending.run_id);
    const status = await r.admin('status');
    assert.equal(status.state, 'COMPLETE');
    assert.equal(status.dry_run, true);
  } finally {
    await r.fake.close();
  }
});

test('an armed trigger runs live, and abort releases every override', async () => {
  const r = await rig({ holdMinutes: 20 });
  try {
    await r.admin('trigger', { op: 'save', rule: RULE });
    const refused = await r.admin('trigger', { op: 'arm', confirm: true, phrase: 'yes' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'confirm_required');
    const armed = await r.admin('trigger', { op: 'arm', confirm: true, phrase: 'ARM', by: 'operator' });
    assert.equal(armed.trigger.mode, 'armed');
    assert.equal((await r.fire()).live, true);
    let session = await r.tick();
    for (let n = 0; n < 6 && !session.runner.state.stepWritten; n += 1) session = await r.tick();
    assert.equal(session.runner.state.phase, 'STEP');
    assert.ok(r.writes() > 0);
    const status = await r.admin('status');
    assert.equal(status.state, 'STEP');
    assert.equal(status.dry_run, false);
    assert.equal(status.steps[1].step_id, 'ahu.recirc');
    assert.equal(status.steps[1].hold_ms, 20 * 60000);
    await session.runner.abort();
    assert.equal(session.runner.state.phase, 'ABORTED');
    await noActiveCommands(r.client);
    for (const item of Object.values(r.model.equipment[0].points)) {
      const typed = /** @type {any} */ (item);
      if (!typed.writable) continue;
      assert.equal((await r.client.readPriorityArray({ uuid: typed.uuid }))[7], null);
    }
    assert.equal(r.ledger.openOverrides().length, 0);
  } finally {
    await r.fake.close();
  }
});

test('a held run, an unreadable blackout schedule, or an early call does not start', async () => {
  const r = await rig({
    scheduleClient: { getSchedule: async () => { throw new Error('offline'); } },
  });
  try {
    await r.admin('trigger', { op: 'save', rule: RULE, blackout: { schedule_uuid: 'sched-1' } });
    await r.admin('trigger', { op: 'dry_run' });
    const blocked = await r.fire();
    assert.equal(blocked.action, 'skip');
    assert.equal(blocked.reason, 'blackout_schedule_unavailable');
    assert.equal(readState(r.root).pending_start, null);
    writeTrigger(r.root, { ...readTrigger(r.root), blackout: { schedule_uuid: '' }, last_occurrence: null });
    writeState(r.root, { pending_start: null, state: { phase: 'STEP' } });
    const held = await r.fire();
    assert.equal(held.action, 'skip');
    assert.equal(held.reason, 'run_active');
    assert.equal(readState(r.root).pending_start, null);
    r.clock.advance(20 * 60000);
    assert.equal((await r.fire()).reason, 'not_due');
    const off = loadHook('../hooks/trigger');
    const offSession = createSession();
    offSession.root = r.root;
    offSession.clock = r.clock;
    offSession.factory = r.factory;
    off.useSession(offSession);
    assert.equal((await off({ options: { enabled: false } })).reason, 'app_disabled');
  } finally {
    await r.fake.close();
  }
});

test('a holiday in the NF schedule skips the run', async () => {
  const holiday = { schedule: { uuid: 'sched-1', defaultValue: { boolean: false }, specialEvents: [{ name: 'Holiday', date: { year: 2026, month: 11, day: 26 }, timeValues: [] }] } };
  const r = await rig({ scheduleClient: { getSchedule: async () => holiday } });
  try {
    await r.admin('trigger', { op: 'save', rule: RULE, blackout: { schedule_uuid: 'sched-1' } });
    await r.admin('trigger', { op: 'dry_run' });
    const result = await r.fire();
    assert.equal(result.reason, 'special_event:Holiday');
    assert.equal(readTrigger(r.root).history[0].action, 'skip');
    assert.equal(readState(r.root).pending_start, null);
  } finally {
    await r.fake.close();
  }
});

test('admin trigger and preview actions write nothing to equipment', async () => {
  const r = await rig();
  try {
    const bad = await r.admin('trigger', { op: 'save', rule: { kind: 'weekly', weekdays: [] } });
    assert.equal(bad.code, 'invalid_rule');
    assert.equal((await r.admin('trigger', { op: 'explode' })).code, 'unknown_op');
    assert.equal((await r.admin('plan_preview')).code, 'site_config');
    assert.equal(r.writes(), 0);
    const { adminAction } = require('../lib/admin');
    const memory = createSession();
    memory.options = { siteConfig: fs.readFileSync('examples/site-config.example.json', 'utf8') };
    const preview = await adminAction(memory, 'plan_preview', {});
    assert.equal(preview.ok, true);
    assert.equal(preview.writes, 0);
    assert.equal(preview.dry_run, true);
    assert.ok(preview.steps.some((s) => s.writes.length > 0));
    assert.equal((await adminAction({ ...memory, options: { siteConfig: '{' } }, 'plan_preview', {})).code, 'site_config');
    assert.equal((await adminAction({ ...memory, options: { siteConfig: '{"version":1,"dry_run":"x"}' } }, 'plan_preview', {})).code, 'site_config');
    const kept = await adminAction(memory, 'trigger', { op: 'dry_run' });
    assert.equal(kept.trigger.mode, 'dry_run');
    assert.equal((await adminAction(memory, 'trigger', {})).trigger.mode, 'dry_run');
  } finally {
    await r.fake.close();
  }
});
