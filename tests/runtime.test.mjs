import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSession, tick } = require('../hooks/lib/admin');
const { buildPlan } = require('../hooks/lib/plan');
const { readState, writeState } = require('../hooks/lib/persist');
const {
  boundedQuery,
  createFactory,
  defaultStateRoot,
  ensureRuntime,
  modelFromBindings,
  nfBaseUrl,
  resolveQueryBindings,
} = require('../hooks/lib/runtime');

function exampleConfig() {
  return JSON.parse(fs.readFileSync('examples/site-config.example.json', 'utf8'));
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('state root and NF base URL come from the option, then the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  assert.equal(withEnv('NF_HVAC_STATE_DIR', dir, () => defaultStateRoot()), dir);
  assert.match(withEnv('NF_HVAC_STATE_DIR', undefined, () => defaultStateRoot()), /local$/);
  assert.equal(nfBaseUrl({ options: { nfBaseUrl: 'http://127.0.0.1:9' } }), 'http://127.0.0.1:9');
  assert.equal(withEnv('NF_BASE_URL', 'http://127.0.0.1:10', () => nfBaseUrl({})), 'http://127.0.0.1:10');
  assert.equal(withEnv('NF_BASE_URL', undefined, () => nfBaseUrl({})), 'http://127.0.0.1:8080');
  assert.equal(boundedQuery(null), null);
  assert.deepEqual(boundedQuery({ uuid: 'abc' }), { uuid: 'abc' });
  assert.equal(boundedQuery({ equip_ref: '' }), null);
  assert.deepEqual(boundedQuery({ equip_ref: 'ahu_a', markers: ['fan'], layer: 'hpl:bacnet:1' }), {
    equip_ref: 'ahu_a',
    markers: ['fan'],
    layer: 'hpl:bacnet:1',
  });
});

test('a model is built from configured uuids and does not query the site', () => {
  const model = modelFromBindings(exampleConfig());
  const plan = buildPlan(model, exampleConfig());
  assert.equal(plan.ready, true, plan.reason);
  const ahu = model.equipment.find((item) => item.id === 'ahu_a');
  assert.equal(ahu.points.supply_fan_command.writable, false);
  assert.equal(ahu.points.outdoor_air_intake_damper_position_command.writable, true);
  assert.equal(ahu.points.discharge_air_temperature.unit, 'DEG_C');
  const custom = exampleConfig();
  custom.equipment[0].points.discharge_air_temperature.unit = 'degF';
  custom.equipment[0].points.supply_fan_command.writable = true;
  custom.equipment[0].points.not_a_role = {
    uuid: '00000000-0000-4000-8000-0000000000bb',
    layer: 'hpl:bacnet:1',
  };
  const adjusted = modelFromBindings(custom);
  const adjustedAhu = adjusted.equipment.find((item) => item.id === 'ahu_a');
  assert.equal(adjustedAhu.points.discharge_air_temperature.unit, 'degF');
  assert.equal(adjustedAhu.points.supply_fan_command.writable, false);
  assert.equal(adjustedAhu.points.not_a_role, undefined);
});

test('query bindings resolve one equipment at a time', async () => {
  const config = exampleConfig();
  const binding = config.equipment[0].points.outdoor_air_intake_relative_humidity;
  delete binding.uuid;
  delete binding.layer;
  binding.query = { equip_ref: 'ahu_a', markers: ['outside', 'humidity'] };
  const calls = [];
  const resolved = await resolveQueryBindings(config, {
    async queryPoints(query) {
      calls.push(query);
      return { points: [{ uuid: '00000000-0000-4000-8000-0000000000aa', layer: 'hpl:bacnet:1' }] };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].equip_ref, 'ahu_a');
  assert.equal(resolved.equipment[0].points.outdoor_air_intake_relative_humidity.uuid, '00000000-0000-4000-8000-0000000000aa');
  assert.equal(config.equipment[0].points.outdoor_air_intake_relative_humidity.uuid, undefined);

  const several = await resolveQueryBindings(config, {
    async queryPoints() {
      return { points: [{ uuid: '1' }, { uuid: '2' }] };
    },
  });
  assert.equal(several.equipment[0].points.outdoor_air_intake_relative_humidity.uuid, undefined);

  const bare = exampleConfig();
  bare.equipment[0].points.outdoor_air_intake_relative_humidity = { query: {} };
  await assert.rejects(
    () => resolveQueryBindings(bare, { async queryPoints() { return { points: [] }; } }),
    (error) => /** @type {any} */ (error).code === 'query_unbounded',
  );
});

test('the factory refuses a bad config and builds a dry-run runner from uuids', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const session = createSession();
  session.root = root;
  let queries = 0;
  session.client = {
    async queryPoints() {
      queries += 1;
      return { points: [] };
    },
  };
  const factory = createFactory(session, { options: { siteConfig: exampleConfig(), nfBaseUrl: 'http://127.0.0.1:9' } });
  const runner = await factory({ confirm_live: true });
  assert.ok(runner);
  assert.equal(queries, 0);
  assert.equal(runner.plan.ready, true);
  assert.equal(runner.writer.backend, 'dry_run');

  const missing = createFactory(session, { options: { siteConfig: '' } });
  assert.equal(await missing({}), null);
  assert.equal(session.last_error, 'site_config');

  const broken = createFactory(session, { options: { siteConfig: '{' } });
  assert.equal(await broken({}), null);
  assert.equal(session.last_error, 'site_config');

  const invalid = createFactory(session, { options: { siteConfig: JSON.stringify({ version: 1 }) } });
  assert.equal(await invalid({}), null);

  const networked = createSession();
  networked.root = root;
  const remote = createFactory(networked, { options: { siteConfig: exampleConfig(), nfBaseUrl: 'http://127.0.0.1:9' } });
  const built = await remote({});
  assert.ok(built);
  assert.equal(built.client.baseUrl, 'http://127.0.0.1:9');

  const unbounded = exampleConfig();
  unbounded.equipment[0].points.outdoor_air_intake_relative_humidity = { query: {} };
  const refused = createFactory(session, { options: { siteConfig: unbounded } });
  assert.equal(await refused({}), null);
  assert.equal(session.last_error, 'site_config');
});

test('ensureRuntime leaves an injected factory alone and otherwise installs one', () => {
  const injected = createSession();
  injected.factory = () => null;
  ensureRuntime(injected, { options: {} });
  assert.equal(injected.root, undefined);
  const fresh = createSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-'));
  withEnv('NF_HVAC_STATE_DIR', dir, () => ensureRuntime(fresh, { options: { siteConfig: '' } }));
  assert.equal(fresh.root, dir);
  assert.equal(typeof fresh.factory, 'function');
});

test('a new hook process resumes the VAV batch cursor from the state file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-'));
  writeState(root, { pending_start: null, state: { phase: 'STEP', runId: 'run_cursor' } });

  function runner() {
    return /** @type {any} */ ({
      state: { phase: 'STEP', runId: 'run_cursor' },
      manifest: { dry_run: true, overrides: [] },
      vavIndex: 0,
      nextRetryAt: 0,
      lastExtendAt: null,
      seen: null,
      ledger: {
        openOverrides() { return []; },
        openPeriods() { return []; },
      },
      async tick() {
        this.seen = this.vavIndex;
        this.vavIndex = 4;
        this.nextRetryAt = 99;
        this.lastExtendAt = 7;
      },
    });
  }

  const first = createSession();
  first.root = root;
  first.factory = async () => runner();
  await tick({ options: { enabled: true }, setGlobal() {} }, first);
  assert.equal(first.runner.seen, 0);
  const saved = readState(root);
  assert.equal(saved.cursor.vav_index, 4);
  assert.equal(saved.cursor.next_retry_at, 99);
  assert.equal(saved.cursor.last_extend_at, 7);

  const second = createSession();
  second.root = root;
  second.factory = async () => runner();
  await tick({ options: { enabled: true }, setGlobal() {} }, second);
  assert.equal(second.runner.seen, 4);

  const third = createSession();
  third.root = root;
  third.last_error = 'site_config';
  third.factory = async () => null;
  writeState(root, { pending_start: { run_id: 'run_next', confirm_live: false }, state: { phase: 'IDLE' } });
  await tick({ options: { enabled: true }, setGlobal() {} }, third);
  assert.equal(readState(root).last_error, 'site_config');
});
