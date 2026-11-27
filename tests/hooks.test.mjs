import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFake } = require('./fixtures/fake/server');
const { VirtualClock } = require('./fixtures/fake/clock');
const { NfClient } = require('../hooks/lib/nf/client');
const { Ledger } = require('../hooks/lib/ledger');
const { loadHaystackModel } = require('../hooks/lib/model');
const { buildPlan } = require('../hooks/lib/plan');
const { applyDefaults } = require('../hooks/lib/config/defaults');
const { Runner } = require('../hooks/lib/runner');
const { createSession } = require('../hooks/lib/admin');
const { readState } = require('../hooks/lib/persist');

const LAYER = 'hpl:bacnet:1';

function point(equip, tags, n, writable) {
  /** @type {Record<string, string>} */
  const attrs = { equipRef: equip, class: 'point', markers: tags.join(',') };
  if (writable) attrs.writable = 'm:';
  const hex = n.toString(16).padStart(12, '0');
  return { uuid: `00000000-0000-4000-8000-${hex}`, layer: LAYER, attrs };
}

function loadHook(name) {
  const resolved = require.resolve(name);
  delete require.cache[resolved];
  return require(name);
}

test('two hook instances share only the state directory', async () => {
  const clock = new VirtualClock(Date.parse('2026-01-01T00:00:00Z'));
  const fake = await createFake({ clock });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
  try {
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
    const ids = {};
    for (const item of Object.values(model.equipment[0].points)) {
      const typed = /** @type {any} */ (item);
      ids[typed.role] = typed.uuid;
    }
    fake.seedAhu({ points: ids, oat: 12, rat: 24, fanOn: true });
    const config = applyDefaults({
      version: 1,
      dry_run: false,
      write: { backend: 'nf_command', bacnet_priority: 8, command_lease_s: 300, release_retries: 0, release_backoff_s: [1] },
      plan: {
        ahu_strategy: 'per_point',
        steps: [
          { step_id: 'ahu.baseline', hold_minutes: 0 },
          { step_id: 'ahu.recirc', hold_minutes: 0 },
          { step_id: 'ahu.economizer', enabled: false },
          { step_id: 'vav.max_cool', enabled: false },
          { step_id: 'recovery', hold_minutes: 0 },
        ],
      },
      logging: { mode: 'shadow' },
      limits: { max_total_minutes: 150, max_tick_gap_s: 3600, max_comm_failures: 3 },
    });
    const plan = buildPlan(model, config);
    assert.equal(plan.ready, true);
    const client = new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} });
    const ledger = new Ledger(path.join(root, 'ledger'));
    const factory = (args) => new Runner({
      client,
      ledger,
      config,
      plan,
      model,
      clock,
      fanOnMs: 0,
      confirmLive: args.confirm_live === true,
      sleep: async () => {},
    });

    const admin = loadHook('../hooks/admin');
    const adminSession = createSession();
    adminSession.root = root;
    adminSession.factory = factory;
    admin.useSession(adminSession);
    const refused = await admin({ args: { action: 'start', payload: JSON.stringify({ live: true, confirm_live: false }) } });
    assert.equal(refused.code, 'confirm_live');
    assert.equal((await client.listCommands()).commands.length, 0);

    const queued = await admin({ args: { action: 'start', payload: JSON.stringify({ confirm_live: true, run_id: 'run_hook' }) } });
    assert.equal(queued.pending, true);
    assert.equal(adminSession.runner, null);
    assert.equal(readState(root).pending_start.run_id, 'run_hook');

    let phase = 'IDLE';
    for (let n = 0; n < 12 && phase !== 'COMPLETE' && phase !== 'FAILED' && phase !== 'ABORTED' && phase !== 'NEEDS_ATTENTION'; n += 1) {
      const tick = loadHook('../hooks/tick');
      const session = createSession();
      session.root = root;
      session.factory = factory;
      tick.useSession(session);
      await tick({ options: { enabled: true }, setGlobal() {} });
      phase = session.runner.state.phase;
      assert.equal(session.runner.state.runId, 'run_hook');
    }
    assert.equal(phase, 'COMPLETE');
    assert.equal(ledger.openOverrides().length, 0);
    const resumed = factory({ confirm_live: true });
    await resumed.recoverForeign('run_hook');
  } finally {
    await fake.close();
  }
});
