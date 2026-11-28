import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFake } = require('./fixtures/fake/server');
const { DeviceObject } = require('./fixtures/fake/device');
const { VirtualClock } = require('./fixtures/fake/clock');
const { NfClient } = require('../hooks/lib/nf/client');
const { Ledger } = require('../hooks/lib/ledger');
const { loadHaystackModel } = require('../hooks/lib/model');
const { buildPlan } = require('../hooks/lib/plan');
const { applyDefaults } = require('../hooks/lib/config/defaults');
const { Runner, runnableSteps } = require('../hooks/lib/runner');
const { next } = require('../hooks/lib/machine');
const { shadowUuid } = require('../hooks/lib/sampler');

const LAYER = 'hpl:bacnet:1';

/**
 * @param {string} equip
 * @param {string[]} tags
 * @param {number} n
 * @param {boolean} writable
 */
function point(equip, tags, n, writable) {
  /** @type {Record<string, string>} */
  const attrs = { equipRef: equip, class: 'point', markers: tags.join(',') };
  if (writable) attrs.writable = 'm:';
  const hex = n.toString(16).padStart(12, '0');
  return { uuid: `00000000-0000-4000-8000-${hex}`, layer: LAYER, attrs };
}

function modelFor(extra = {}) {
  const points = [
    point('ahu_a', ['discharge', 'air', 'temp', 'sensor'], 1, false),
    point('ahu_a', ['mixed', 'air', 'temp', 'sensor'], 2, false),
    point('ahu_a', ['return', 'air', 'temp', 'sensor'], 3, false),
    point('ahu_a', ['outside', 'air', 'temp', 'sensor'], 4, false),
    point('ahu_a', ['discharge', 'air', 'pressure', 'sensor'], 5, false),
    point('ahu_a', ['fan', 'run', 'sensor'], 6, false),
    point('ahu_a', ['cool', 'valve', 'cmd'], 7, true),
    point('ahu_a', ['heat', 'valve', 'cmd'], 8, true),
    point('ahu_a', ['outside', 'damper', 'cmd'], 9, true),
    point('ahu_a', ['freezeStat', 'sensor'], 10, false),
    point('ahu_a', ['smoke', 'alarm', 'sensor'], 11, false),
  ];
  /** @type {any[]} */
  const equipment = [{ id: 'ahu_a', type: 'ahu', tags: ['ahu'] }];
  if (extra.zone || extra.flow) {
    equipment.push({ id: 'vav_01', type: 'vav', tags: ['vav'], ahuRef: 'ahu_a' });
    points.push(point('vav_01', ['zone', 'air', 'temp', 'sensor'], 12, false));
  }
  if (extra.flow) {
    points.push(point('vav_01', ['air', 'flow', 'sensor'], 14, false));
    points.push(point('vav_01', ['max', 'air', 'flow', 'sp'], 15, false));
    points.push(point('vav_01', ['air', 'flow', 'sp'], 16, true));
  }
  if (extra.mode) points.push(point('ahu_a', ['ahu', 'test', 'mode', 'cmd'], 13, true));
  return loadHaystackModel({ equipment, points });
}

/**
 * @param {Record<string, unknown>} [extra]
 */
function configFor(extra = {}) {
  return applyDefaults({
    version: 1,
    dry_run: false,
    ...extra,
    write: {
      backend: 'nf_command',
      bacnet_priority: 8,
      command_lease_s: 300,
      release_retries: 1,
      release_backoff_s: [1, 1],
      ...(extra.write || {}),
    },
    plan: {
      ahu_strategy: 'per_point',
      steps: [
        { step_id: 'ahu.baseline', hold_minutes: 0 },
        { step_id: 'ahu.recirc', hold_minutes: 0 },
        { step_id: 'ahu.economizer', hold_minutes: 0 },
        { step_id: 'vav.max_cool', enabled: false, hold_minutes: 0 },
        { step_id: 'recovery', hold_minutes: 0 },
      ],
      ...(extra.plan || {}),
    },
    logging: { mode: 'shadow', ...(extra.logging || {}) },
    limits: { max_total_minutes: 150, max_tick_gap_s: 60, max_comm_failures: 3, ...(extra.limits || {}) },
  });
}

/**
 * @param {any} model
 * @param {any} fake
 */
function seed(model, fake) {
  const { DeviceObject } = require('./fixtures/fake/device');
  /** @type {Record<string, string>} */
  const ids = {};
  for (const point of Object.values(model.equipment[0].points)) {
    const typed = /** @type {any} */ (point);
    ids[typed.role] = typed.uuid;
  }
  fake.seedAhu({
    points: ids,
    oat: 12,
    rat: 24,
    rh: 40,
    fanOn: true,
  });
  for (const equipment of model.equipment) {
    for (const point of Object.values(equipment.points)) {
      const typed = /** @type {any} */ (point);
      if (fake.points.has(typed.uuid)) continue;
      const binary = typed.role.endsWith('status') || typed.role.includes('alarm');
      fake.points.set(typed.uuid, new DeviceObject({
        uuid: typed.uuid,
        layer: LAYER,
        type: typed.writable ? 'ao' : 'ai',
        relinquish: binary ? false : 22,
        unit: binary ? 'bool' : '',
        role: typed.role,
      }));
    }
  }
}

async function world(extra = {}) {
  const clock = new VirtualClock(Date.parse('2026-01-01T00:00:00Z'));
  const fake = await createFake({ clock });
  const model = modelFor(extra.model || {});
  seed(model, fake);
  const config = configFor(extra.config || {});
  const plan = buildPlan(model, config);
  const client = new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} });
  const ledger = new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), 'run-')));
  const runner = new Runner({
    client,
    ledger,
    config,
    plan,
    model,
    clock,
    fanOnMs: 0,
    confirmLive: extra.confirmLive !== false,
    sampleAgeS: extra.sampleAgeS || 0,
    sleep: async () => {},
  });
  return { clock, fake, model, config, plan, client, ledger, runner };
}

async function slotsClear(client, model) {
  for (const equipment of model.equipment) {
    for (const point of Object.values(equipment.points)) {
      const typed = /** @type {any} */ (point);
      if (!typed.writable) continue;
      const array = await client.readPriorityArray({ uuid: typed.uuid });
      if (!array) continue;
      assert.equal(array[7], null);
    }
  }
}

test('a full ahu plan releases, and dry-run writes nothing', async () => {
  const live = await world({ model: { zone: true } });
  try {
    assert.equal(live.plan.ready, true);
    await live.runner.start('run_live');
    let guard = 0;
    while (!['COMPLETE', 'FAILED', 'ABORTED', 'NEEDS_ATTENTION'].includes(live.runner.state.phase) && guard < 20) {
      await live.runner.tick();
      guard += 1;
    }
    assert.equal(live.runner.state.phase, 'COMPLETE');
    assert.equal(live.runner.manifest.release.all_verified, true);
    await slotsClear(live.client, live.model);
    assert.equal((await live.client.listCommands()).commands.length, 0);
    for (const sample of live.runner.manifest.samples) {
      const window = live.runner.manifest.steps.find((step) => step.index === sample.step_index && !step.skipped);
      assert.ok(window);
      const ts = sample.ts;
      assert.ok(ts >= Date.parse(window.started_at));
      assert.ok(ts <= Date.parse(window.ended_at));
    }
    assert.equal(shadowUuid('ftest_run_seq'), shadowUuid('ftest_run_seq'));
  } finally {
    await live.fake.close();
  }

  const dry = await world({ config: { dry_run: true }, confirmLive: false });
  try {
    let writes = 0;
    dry.client.writeInCommand = async () => { writes += 1; return { writes: [], errors: [] }; };
    dry.client.bacnetWrite = async () => { writes += 1; return { results: [], errors: [] }; };
    await dry.runner.start('run_dry');
    let guard = 0;
    while (dry.runner.state.phase !== 'COMPLETE' && guard < 20) {
      await dry.runner.tick();
      guard += 1;
    }
    assert.equal(dry.runner.state.phase, 'COMPLETE');
    assert.equal(writes, 0);
    assert.ok(dry.runner.manifest.overrides.every((item) => item.dry_run === true));
  } finally {
    await dry.fake.close();
  }
});

test('abort releases at each phase, and faults release what was written', async () => {
  const phases = ['PRECHECK', 'BASELINE', 'STEP', 'RECOVERY', 'RELEASING'];
  for (const phase of phases) {
    const rig = await world();
    try {
      if (phase === 'PRECHECK') {
        const steps = runnableSteps(rig.plan, rig.config);
        rig.runner.apply(next(rig.runner.state, { type: 'START', now: rig.clock.now(), runId: 'pre', steps }));
      } else if (phase === 'BASELINE') {
        await rig.runner.start('base');
      } else if (phase === 'STEP') {
        await rig.runner.start('step');
        await rig.runner.tick();
      } else if (phase === 'RECOVERY') {
        await rig.runner.start('rec');
        let guard = 0;
        while (rig.runner.state.phase !== 'RECOVERY' && guard < 20) {
          await rig.runner.tick();
          guard += 1;
        }
      } else {
        await rig.runner.start('rel');
        rig.runner.state.phase = 'RELEASING';
      }
      assert.equal(rig.runner.state.phase, phase);
      await rig.runner.abort();
      assert.equal(rig.runner.state.phase, 'ABORTED');
      await slotsClear(rig.client, rig.model);
      assert.equal((await rig.client.listCommands()).commands.length, 0);
    } finally {
      await rig.fake.close();
    }
  }

  const fault = await world();
  try {
    await fault.runner.start('fault');
    await fault.runner.tick();
    await fault.runner.tick();
    assert.equal(fault.runner.state.stepWritten, true);
    const damper = fault.model.equipment[0].points.outdoor_air_intake_damper_position_command.uuid;
    fault.fake.points.get(damper).slots[3] = 7;
    await fault.runner.tick();
    assert.equal(fault.runner.state.reason, 'interlock:override_conflict');
    assert.equal((await fault.client.readPriorityArray({ uuid: damper }))[7], null);
    assert.equal((await fault.client.readPriorityArray({ uuid: damper }))[2], 7);

    const boom = await world();
    const real = boom.runner.writer.write.bind(boom.runner.writer);
    let calls = 0;
    boom.runner.writer.write = async (spec) => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return real(spec);
    };
    await boom.runner.start('boom');
    let guard = 0;
    while (!['FAILED', 'ABORTED', 'COMPLETE', 'NEEDS_ATTENTION'].includes(boom.runner.state.phase) && guard < 10) {
      await boom.runner.tick();
      guard += 1;
    }
    assert.equal(boom.runner.state.reason, 'exception');
    await slotsClear(boom.client, boom.model);
    await boom.fake.close();
  } finally {
    await fault.fake.close();
  }
});

test('interlocks, comm loss, tick gap, and timeout all release', async () => {
  const rig = await world({ model: { zone: true } });
  try {
    await rig.runner.start('locks');
    await rig.runner.tick();
    await rig.runner.tick();
    /** @type {[string, (point: any) => void][]} */
    const cases = [
      ['discharge_air_static_pressure', (point) => { point.presentOverride = 5000; }],
      ['discharge_air_temperature', (point) => { point.derive = () => 1; }],
      ['supply_fan_operating_status', (point) => { point.presentOverride = false; }],
      ['air_temperature_low_limit_alarm_status', (point) => { point.presentOverride = true; }],
      ['air_smoke_alarm_status', (point) => { point.presentOverride = true; }],
    ];
    const duct = rig.model.equipment[0].points.discharge_air_static_pressure.uuid;
    rig.fake.points.get(duct).presentOverride = 5000;
    await rig.runner.tick();
    assert.match(rig.runner.state.reason, /^interlock:/);
    await slotsClear(rig.client, rig.model);
    for (const [role, plant] of cases) {
      const again = await world({ model: { zone: true } });
      try {
        await again.runner.start(`lock_${role}`);
        await again.runner.tick();
        await again.runner.tick();
        const uuid = again.model.equipment[0].points[role].uuid;
        plant(again.fake.points.get(uuid));
        await again.runner.tick();
        assert.equal(again.runner.state.phase, 'FAILED');
        await slotsClear(again.client, again.model);
      } finally {
        await again.fake.close();
      }
    }
  } finally {
    await rig.fake.close();
  }

  const zone = await world({
    model: { zone: true },
    config: { plan: { steps: [
      { step_id: 'ahu.baseline', hold_minutes: 30 },
      { step_id: 'recovery', hold_minutes: 0 },
    ] } },
  });
  try {
    await zone.runner.start('zone');
    const uuid = zone.model.equipment.find((item) => item.id === 'vav_01').points.zone_air_temperature.uuid;
    zone.fake.points.get(uuid).presentOverride = 40;
    await zone.runner.tick();
    zone.clock.advance(5 * 60 * 1000);
    await zone.runner.tick();
    assert.equal(zone.runner.state.reason, 'interlock:zone_out_of_band');
  } finally {
    await zone.fake.close();
  }

  const stale = await world({ sampleAgeS: 500, config: { limits: { max_sample_age_s: 30 } } });
  try {
    await stale.runner.start('stale');
    await stale.runner.tick();
    assert.equal(stale.runner.state.reason, 'interlock:stale_data');
  } finally {
    await stale.fake.close();
  }

  const comm = await world();
  try {
    await comm.runner.start('comm');
    comm.client.readPoints = async () => { throw new Error('down'); };
    await comm.runner.tick();
    await comm.runner.tick();
    await comm.runner.tick();
    assert.equal(comm.runner.state.reason, 'comm_loss');
    await slotsClear(comm.client, comm.model);
  } finally {
    await comm.fake.close();
  }

  const gap = await world();
  try {
    await gap.runner.start('gap');
    gap.clock.advance(120 * 1000);
    await gap.runner.tick();
    assert.equal(gap.runner.state.reason, 'tick_gap');
    await slotsClear(gap.client, gap.model);
  } finally {
    await gap.fake.close();
  }

  const timed = await world({ config: { limits: { max_total_minutes: 0 } } });
  try {
    await timed.runner.start('time');
    timed.clock.advance(1);
    await timed.runner.tick();
    assert.equal(timed.runner.state.reason, 'timeout');
  } finally {
    await timed.fake.close();
  }
});

test('restart during recirc releases before anything else', async () => {
  const rig = await world();
  try {
    await rig.runner.start('crash');
    await rig.runner.tick();
    await rig.runner.tick();
    assert.equal(rig.runner.state.steps[rig.runner.state.stepIndex].step_id, 'ahu.recirc');
    const restarted = new Runner({
      client: rig.client,
      ledger: rig.ledger,
      config: rig.config,
      plan: rig.plan,
      model: rig.model,
      clock: rig.clock,
      fanOnMs: 0,
      confirmLive: true,
      sleep: async () => {},
    });
    const result = await restarted.recover();
    assert.equal(result.needsAttention, false);
    await slotsClear(rig.client, rig.model);
    assert.equal((await rig.client.listCommands()).commands.length, 0);
  } finally {
    await rig.fake.close();
  }
});

test('mode point writes the mode value and a hot outside air skips economizer', async () => {
  const mode = await world({
    model: { mode: true },
    config: { plan: { ahu_strategy: 'mode_point' } },
  });
  try {
    await mode.runner.start('mode');
    await mode.runner.tick();
    await mode.runner.tick();
    const uuid = mode.model.equipment[0].points.test_operating_mode_command.uuid;
    assert.equal((await mode.client.readPriorityArray({ uuid }))[7], 1);
    let guard = 0;
    while (mode.runner.state.phase !== 'COMPLETE' && guard < 20) {
      await mode.runner.tick();
      guard += 1;
    }
    assert.equal(mode.runner.state.phase, 'COMPLETE');
  } finally {
    await mode.fake.close();
  }

  const hot = await world();
  try {
    hot.fake.points.get(hot.model.equipment[0].points.outdoor_air_intake_temperature.uuid).presentOverride = 30;
    await hot.runner.start('hot');
    let guard = 0;
    while (hot.runner.state.phase !== 'COMPLETE' && guard < 20) {
      await hot.runner.tick();
      guard += 1;
    }
    assert.equal(hot.runner.state.phase, 'COMPLETE');
    assert.ok(hot.runner.manifest.steps.some((step) => step.step_id === 'ahu.economizer' && step.skipped));
  } finally {
    await hot.fake.close();
  }
});

test('boost, fan stability, unbound writes, and vav expansion are explicit', async () => {
  const rig = await world({ config: { logging: { mode: 'period_boost', max_boosted_points: 2 } } });
  try {
    rig.runner.fanOnMs = 10 * 60 * 1000;
    const blocked = await rig.runner.start('boost');
    assert.equal(blocked.reason, 'fan_not_stable');
    assert.equal(rig.ledger.openPeriods().length, 0);
    rig.runner.fanOnMs = 0;
    rig.runner.state = { ...rig.runner.state, phase: 'PRECHECK', reason: '' };
    const ready = await rig.runner.exec({ type: 'precheck' });
    assert.ok(ready);
    assert.equal(ready && ready.type, 'PRECHECK_OK');
    assert.ok(rig.ledger.openPeriods().length > 0);
    rig.runner.state = { ...rig.runner.state, phase: 'NEEDS_ATTENTION', needsAttention: true };
    await rig.runner.acknowledge();
    assert.equal(rig.runner.state.phase, 'IDLE');
    assert.equal(rig.runner.attention, 0);
    assert.equal(await rig.runner.exec({ type: 'nope' }), null);
    rig.runner.fanOnMs = 0;
    rig.runner.state.steps = [{ writes: [{ equipment_id: 'missing', role: 'cooling_valve_position_command' }] }];
    const unbound = await rig.runner.precheck();
    assert.equal(unbound.reason, 'role_unbound:cooling_valve_position_command');
    const damper = rig.model.equipment[0].points.outdoor_air_intake_damper_position_command;
    rig.ledger.append({
      kind: 'active',
      run_id: 'old',
      equipment_id: 'ahu_a',
      uuid: damper.uuid,
      layer: LAYER,
      priority: 8,
      value: 0,
      backend: 'nf_command',
      command_name: 'ftest-old-ahu_a',
    });
    rig.fake.points.get(damper.uuid).offline = true;
    const held = await rig.runner.start('held');
    assert.equal(held.needsAttention, true);
    const expanded = runnableSteps({
      equipment_id: 'ahu_a',
      steps: [{
        step_id: 'vav.max_cool',
        status: 'included',
        writes: [],
        boxes: [
          { equipment_id: 'vav_01', strategy: 'bas_toggle' },
          { equipment_id: 'vav_02', strategy: 'flush_point' },
          { equipment_id: 'vav_03', strategy: 'airflow_setpoint' },
          { equipment_id: 'vav_04', strategy: null },
        ],
      }, {
        step_id: 'not_in_config',
        status: 'included',
        writes: [{ role: 'cooling_valve_position_command', value: 0 }],
      }],
    }, applyDefaults({ version: 1, vav_test: { airflow_setpoint_default_m3s: 0.4 } }));
    assert.equal(expanded[0].writes.length, 3);
    assert.equal(expanded[1].hold_ms, 0);
  } finally {
    await rig.fake.close();
  }
});

test('two hundred random faults leave no override behind', async () => {
  const clock = new VirtualClock(Date.parse('2026-01-01T00:00:00Z'));
  const fake = await createFake({ clock });
  const model = modelFor({ zone: true });
  seed(model, fake);
  const config = configFor();
  const plan = buildPlan(model, config);
  const client = new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} });
  try {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = mulberry32(seed);
      for (const command of [...fake.commands.values()]) {
        if (command.active) {
          for (const object of fake.points.values()) object.offline = false;
          await client.cancelCommand(command.id);
        }
      }
      for (const object of fake.points.values()) {
        object.offline = false;
        object.presentOverride = null;
        if (object.commandable) object.slots.fill(null);
      }
      const ledger = new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-')));
      const runner = new Runner({
        client, ledger, config, plan, model, clock, fanOnMs: 0, confirmLive: true, sleep: async () => {},
      });
      const fault = ['abort', 'static', 'offline', 'crash', 'gap'][Math.floor(rand() * 5)];
      const at = 1 + Math.floor(rand() * 3);
      await runner.start(`r${seed}`);
      for (let tick = 0; tick < at && runner.state.phase !== 'COMPLETE'; tick += 1) await runner.tick();
      if (fault === 'abort') await runner.abort();
      else if (fault === 'static') {
        fake.points.get(model.equipment[0].points.discharge_air_static_pressure.uuid).presentOverride = 4000;
        await runner.tick();
      } else if (fault === 'offline') {
        const damper = model.equipment[0].points.outdoor_air_intake_damper_position_command.uuid;
        fake.points.get(damper).offline = true;
        for (let extra = 0; extra < 4; extra += 1) await runner.tick();
        fake.points.get(damper).offline = false;
        if (runner.state.needsAttention) await runner.retryRelease();
      } else if (fault === 'crash') {
        const nextRunner = new Runner({
          client, ledger, config, plan, model, clock, fanOnMs: 0, confirmLive: true, sleep: async () => {},
        });
        await nextRunner.recover();
        if (nextRunner.state.needsAttention) {
          for (const object of fake.points.values()) object.offline = false;
          await nextRunner.retryRelease();
        }
      } else {
        clock.advance(120 * 1000);
        await runner.tick();
      }
      if (runner.state.needsAttention) {
        for (const object of fake.points.values()) object.offline = false;
        await runner.retryRelease();
      }
      const open = ledger.openOverrides();
      if (open.length === 0) await slotsClear(client, model);
      else {
        for (const equipment of model.equipment) {
          for (const point of Object.values(equipment.points)) {
            const typed = /** @type {any} */ (point);
            if (!typed.writable) continue;
            const array = await client.readPriorityArray({ uuid: typed.uuid });
            if (array && array[7] !== null && array[7] !== undefined) {
              assert.ok(open.some((entry) => entry.uuid === typed.uuid), `seed ${seed} ${fault}`);
            }
          }
        }
      }
      assert.equal((await client.listCommands()).commands.filter((command) => String(command.name).startsWith('ftest-')).length, 0, `seed ${seed} ${fault}`);
    }
  } finally {
    await fake.close();
  }
});

test('release leaves another run holding its slot', async () => {
  const rig = await world();
  try {
    await rig.runner.start('run_scope');
    await rig.runner.tick();
    await rig.runner.tick();
    const damper = rig.model.equipment[0].points.outdoor_air_intake_damper_position_command;
    rig.ledger.append({
      kind: 'active',
      run_id: 'other_run',
      equipment_id: 'ahu_a',
      uuid: damper.uuid,
      layer: damper.layer,
      priority: 8,
      value: 0,
      backend: 'nf_command',
      command_name: 'ftest-other_run-ahu_a',
    });
    await rig.runner.abort();
    const other = rig.ledger.openOverrides().filter((entry) => entry.run_id === 'other_run');
    assert.equal(other.length, 1);
    assert.equal(other[0].kind === 'active' || other[0].value === 0, true);
  } finally {
    await rig.fake.close();
  }
});

test('an old device timestamp trips stale data', async () => {
  const rig = await world({ config: { limits: { max_sample_age_s: 30, max_tick_gap_s: 3600 } } });
  try {
    const old = new Date(rig.clock.now() - 120000).toISOString();
    for (const object of rig.fake.points.values()) object.sampleTs = old;
    await rig.runner.start('aged');
    await rig.runner.tick();
    assert.equal(rig.runner.state.reason, 'interlock:stale_data');
  } finally {
    await rig.fake.close();
  }
});

test('imperial readings trip the SI interlocks', async () => {
  /** @type {{ close: () => Promise<void> }[]} */
  const opened = [];
  try {
    const cold = await world();
    opened.push(cold.fake);
    const discharge = cold.model.equipment[0].points.discharge_air_temperature;
    discharge.unit = 'degF';
    cold.fake.points.get(discharge.uuid).derive = () => 40;
    await cold.runner.start('degf');
    await cold.runner.tick();
    assert.match(cold.runner.state.reason, /discharge_air_low/);

    const pressure = await world();
    opened.push(pressure.fake);
    const duct = pressure.model.equipment[0].points.discharge_air_static_pressure;
    duct.unit = 'inH2O';
    pressure.fake.points.get(duct.uuid).derive = () => 5;
    await pressure.runner.start('inh2o');
    await pressure.runner.tick();
    assert.match(pressure.runner.state.reason, /duct_static_high/);

    const unknown = await world();
    opened.push(unknown.fake);
    unknown.model.equipment[0].points.discharge_air_static_pressure.unit = 'furlong';
    await unknown.runner.start('unknown');
    await unknown.runner.tick();
    assert.match(unknown.runner.state.reason, /unknown_unit:discharge_air_static_pressure/);
  } finally {
    for (const fake of opened) await fake.close();
  }
});

test('a vav discharge temperature does not mask the ahu interlock', async () => {
  const { fake, runner, model } = await world();
  const vavUuid = '00000000-0000-4000-8000-000000000099';
  model.equipment.push({
    id: 'vav_01',
    type: 'vav',
    points: {
      discharge_air_temperature: { role: 'discharge_air_temperature', uuid: vavUuid, layer: LAYER, writable: false },
    },
  });
  runner.points.set('vav_01|discharge_air_temperature', {
    role: 'discharge_air_temperature',
    uuid: vavUuid,
    layer: LAYER,
    writable: false,
  });
  runner.plan.sample_points.push({
    equipment_id: 'vav_01',
    role: 'discharge_air_temperature',
    uuid: vavUuid,
    layer: LAYER,
  });
  const ahuDat = model.equipment[0].points.discharge_air_temperature;
  fake.points.get(ahuDat.uuid).derive = () => 2;
  fake.points.set(vavUuid, new DeviceObject({ uuid: vavUuid, layer: LAYER, type: 'ai', relinquish: 30 }));
  try {
    await runner.start('scope');
    await runner.tick();
    assert.match(runner.state.reason, /discharge_air_low/);
  } finally {
    await fake.close();
  }
});

test('a 20 minute recirc hold completes inside a 5 minute lease', async () => {
  const { clock, fake, runner } = await world({
    config: {
      write: { command_lease_s: 300, keepalive_s: 60, release_retries: 1, release_backoff_s: [1, 1] },
      plan: {
        steps: [
          { step_id: 'ahu.baseline', hold_minutes: 0 },
          { step_id: 'ahu.recirc', hold_minutes: 20 },
          { step_id: 'ahu.economizer', enabled: false },
          { step_id: 'vav.max_cool', enabled: false },
          { step_id: 'recovery', hold_minutes: 0 },
        ],
      },
      limits: { max_total_minutes: 40, max_tick_gap_s: 30, max_comm_failures: 3 },
    },
  });
  try {
    await runner.start('run_hold');
    const terminal = new Set(['COMPLETE', 'ABORTED', 'FAILED', 'NEEDS_ATTENTION']);
    for (let i = 0; i < 200 && !terminal.has(runner.state.phase); i += 1) {
      clock.advance(10 * 1000);
      await runner.tick();
    }
    assert.equal(runner.state.phase, 'COMPLETE');
    assert.equal(runner.state.reason, 'complete');
    assert.ok(runner.lastExtendAt !== null && runner.lastExtendAt > 0);
  } finally {
    await fake.close();
  }
});

test('a restarted runner without live permission releases the live slot', async () => {
  const { clock, fake, runner, client, model, ledger, config, plan } = await world({
    confirmLive: true,
    config: {
      write: {
        command_lease_s: 300,
        keepalive_s: 60,
        release_retries: 1,
        release_backoff_s: [1, 1],
      },
      plan: {
        steps: [
          { step_id: 'ahu.baseline', hold_minutes: 0 },
          { step_id: 'ahu.recirc', hold_minutes: 20 },
          { step_id: 'ahu.economizer', enabled: false },
          { step_id: 'vav.max_cool', enabled: false },
          { step_id: 'recovery', hold_minutes: 0 },
        ],
      },
      limits: { max_total_minutes: 40, max_tick_gap_s: 1000, max_comm_failures: 3 },
    },
  });
  try {
    await runner.start('run_live');
    for (let i = 0; i < 6; i += 1) {
      clock.advance(10 * 1000);
      await runner.tick();
    }
    const uuid = model.equipment[0].points.cooling_valve_position_command.uuid;
    assert.equal((await client.readPriorityArray({ uuid }))[7], 0);
    const restarted = new Runner({
      client, ledger, config, plan, model, clock, fanOnMs: 0, confirmLive: false, sleep: async () => {},
    });
    await restarted.recover();
    const slot = (await client.readPriorityArray({ uuid }))[7];
    const open = ledger.openOverrides().filter((entry) => entry.uuid === uuid);
    assert.equal(slot, null);
    assert.equal(open.length, 0);
    assert.equal(restarted.state.needsAttention, false);
  } finally {
    await fake.close();
  }
});

test('stopping keepalive lets the lease revert the override', async () => {
  const { clock, fake, runner, client, model } = await world({
    config: {
      write: { command_lease_s: 120, keepalive_s: 30, release_retries: 1, release_backoff_s: [1, 1] },
      plan: {
        steps: [
          { step_id: 'ahu.baseline', hold_minutes: 0 },
          { step_id: 'ahu.recirc', hold_minutes: 20 },
          { step_id: 'ahu.economizer', enabled: false },
          { step_id: 'vav.max_cool', enabled: false },
          { step_id: 'recovery', hold_minutes: 0 },
        ],
      },
      limits: { max_total_minutes: 40, max_tick_gap_s: 1000, max_comm_failures: 3 },
    },
  });
  try {
    await runner.start('run_expire');
    for (let i = 0; i < 6; i += 1) {
      clock.advance(10 * 1000);
      await runner.tick();
    }
    const uuid = model.equipment[0].points.cooling_valve_position_command.uuid;
    assert.equal((await client.readPriorityArray({ uuid }))[7], 0);
    clock.advance(121 * 1000);
    assert.equal((await client.readPriorityArray({ uuid }))[7], null);
    assert.equal((await client.listCommands()).commands.length, 0);
  } finally {
    await fake.close();
  }
});

test('a live run refuses a command priority the service does not use', async () => {
  const clock = new VirtualClock(Date.parse('2026-01-01T00:00:00Z'));
  const fake = await createFake({ clock, commandPriority: 12 });
  try {
    const model = modelFor();
    seed(model, fake);
    const config = configFor();
    const runner = new Runner({
      client: new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} }),
      ledger: new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), 'prio-'))),
      config,
      plan: buildPlan(model, config),
      model,
      clock,
      fanOnMs: 0,
      confirmLive: true,
      sleep: async () => {},
    });
    const state = await runner.start('run_priority');
    assert.equal(state.phase, 'FAILED');
    assert.equal(state.reason, 'priority_mismatch:12');
    assert.equal((await runner.client.listCommands()).commands.length, 0);
  } finally {
    await fake.close();
  }
});

test('a missing command priority does not invent the documented default', async () => {
  const clock = new VirtualClock(Date.parse('2026-01-01T00:00:00Z'));
  const hidden = await createFake({ clock, commandPriority: null });
  try {
    const client = new NfClient({ baseUrl: hidden.baseUrl, sleep: async () => {} });
    assert.equal(await client.readCommandPriority(), null);
  } finally {
    await hidden.close();
  }
});

test('a kill during vav max cooling releases the live slot', async () => {
  const rig = await world({
    model: { flow: true },
    config: {
      plan: {
        steps: [
          { step_id: 'ahu.baseline', hold_minutes: 0 },
          { step_id: 'ahu.recirc', enabled: false },
          { step_id: 'ahu.economizer', enabled: false },
          { step_id: 'vav.max_cool', enabled: true, hold_minutes: 30 },
          { step_id: 'recovery', hold_minutes: 0 },
        ],
      },
      vav_test: { strategy: 'airflow_setpoint', min_capable_boxes: 1 },
    },
  });
  try {
    await rig.runner.start('run_vav_kill');
    let guard = 0;
    while (rig.runner.state.phase !== 'STEP' && guard < 8) {
      await rig.runner.tick();
      guard += 1;
    }
    assert.equal(rig.runner.state.phase, 'STEP');
    assert.equal(rig.runner.state.steps[rig.runner.state.stepIndex].step_id, 'vav.max_cool');
    const restarted = new Runner({
      client: rig.client,
      ledger: rig.ledger,
      config: rig.config,
      plan: rig.plan,
      model: rig.model,
      clock: rig.clock,
      fanOnMs: 0,
      confirmLive: false,
      sleep: async () => {},
    });
    await restarted.recover();
    assert.equal(rig.ledger.openOverrides().length, 0);
  } finally {
    await rig.fake.close();
  }
});

test('a fault after later ticks with VAV enabled still releases', async () => {
  const rig = await world({
    model: { flow: true },
    config: {
      plan: {
        steps: [
          { step_id: 'ahu.baseline', hold_minutes: 0 },
          { step_id: 'ahu.recirc', enabled: false },
          { step_id: 'ahu.economizer', enabled: false },
          { step_id: 'vav.max_cool', enabled: true, hold_minutes: 30 },
          { step_id: 'recovery', hold_minutes: 0 },
        ],
      },
      vav_test: { strategy: 'airflow_setpoint', min_capable_boxes: 1 },
    },
  });
  try {
    await rig.runner.start('run_vav_late');
    for (let tick = 0; tick < 6; tick += 1) {
      rig.clock.advance(10 * 1000);
      await rig.runner.tick();
    }
    assert.equal(rig.runner.state.steps[rig.runner.state.stepIndex].step_id, 'vav.max_cool');
    const duct = rig.model.equipment[0].points.discharge_air_static_pressure.uuid;
    rig.fake.points.get(duct).presentOverride = 4000;
    await rig.runner.tick();
    assert.match(rig.runner.state.reason, /^interlock:/);
    assert.equal(rig.ledger.openOverrides().length, 0);
  } finally {
    await rig.fake.close();
  }
});

test('a paced runner releases one batch per tick', async () => {
  const rig = await world({ config: { vav_test: { batch_size: 1, batch_delay_s: 2 }, write: { release_backoff_s: [3] } } });
  try {
    await rig.runner.start('paced');
    await rig.runner.tick();
    await rig.runner.tick();
    rig.runner.paced = true;
    let slept = false;
    rig.runner.sleep = async () => { slept = true; };
    const writer = rig.runner.writer;
    const real = writer.release.bind(writer);
    let calls = 0;
    writer.release = async (entries) => {
      calls += 1;
      if (calls === 1) return { verified: [], failed: entries };
      return real(entries);
    };
    const deferred = await rig.runner.release();
    assert.equal(deferred, null);
    assert.equal(slept, false);
    assert.ok(rig.runner.nextRetryAt > rig.clock.now());
    rig.clock.advance(4 * 1000);
    const again = await rig.runner.release();
    assert.equal(again, null);
    assert.ok(rig.runner.nextRetryAt > rig.clock.now());
  } finally {
    await rig.fake.close();
  }
});

/**
 * @param {number} seed
 */
function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
