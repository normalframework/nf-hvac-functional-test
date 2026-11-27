import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFake } = require('./fixtures/fake/server');
const { NfClient } = require('../hooks/lib/nf/client');
const { Ledger } = require('../hooks/lib/ledger');
const { createWriter } = require('../hooks/lib/writers');
const { DryRunWriter } = require('../hooks/lib/writers/dry_run');
const { NfCommandWriter } = require('../hooks/lib/writers/nf_command');
const { BacnetDirectWriter } = require('../hooks/lib/writers/bacnet_direct');
const { releaseEntries, recover } = require('../hooks/lib/writers/release');
const { parsePriorityArray } = require('../hooks/lib/writers/verify');

const LAYER = 'hpl:bacnet:1';
const UUID = '00000000-0000-4000-8000-000000000101';
const OTHER = '00000000-0000-4000-8000-000000000102';
const LIVE = { dry_run: false, bacnet_priority: 8, backend: 'nf_command', command_lease_s: 300 };

/**
 * @param {string} [prefix]
 */
function tempDir(prefix = 'ledger-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function rig() {
  const fake = await createFake();
  fake.seedAhu({
    points: {
      outdoor_air_intake_damper_position_command: UUID,
      cooling_valve_position_command: OTHER,
    },
  });
  const client = new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} });
  const ledger = new Ledger(tempDir());
  return { fake, client, ledger };
}

test('intent is on disk before the write is sent, and a torn tail is ignored', async () => {
  const { fake, client, ledger } = await rig();
  try {
    const order = [];
    const original = client.writeInCommand.bind(client);
    client.writeInCommand = async (body) => {
      order.push('send');
      const text = fs.readFileSync(ledger.file, 'utf8');
      assert.match(text, /"kind":"intent"/);
      return original(body);
    };
    const writer = createWriter({ config: LIVE, confirmLive: true, client, ledger });
    const wrote = await writer.write({
      run_id: 'run_a',
      equipment_id: 'ahu_a',
      uuid: UUID,
      layer: LAYER,
      value: 0,
    });
    assert.equal(wrote.ok, true);
    assert.deepEqual(order, ['send']);
    const reloaded = new Ledger(ledger.dir);
    assert.equal(reloaded.openOverrides().length, 1);

    fs.appendFileSync(ledger.file, '{"kind":');
    const warnings = [];
    const torn = new Ledger(ledger.dir, { warn: (message) => warnings.push(message) });
    assert.equal(torn.openOverrides().length, 1);
    assert.equal(warnings.includes('corrupt ledger tail ignored'), true);
    const snap = torn.snapshot();
    const parsed = JSON.parse(fs.readFileSync(snap, 'utf8'));
    assert.equal(parsed.records.length >= 2, true);
  } finally {
    await fake.close();
  }
});

test('a failed rewrite does not erase an earlier live override', async () => {
  const { fake, client, ledger } = await rig();
  try {
    const writer = new BacnetDirectWriter({ client, ledger, priority: 8 });
    const first = await writer.write({
      run_id: 'run_a', equipment_id: 'ahu_a', uuid: UUID, layer: LAYER, value: 0,
    });
    assert.equal(first.ok, true);
    const second = await writer.write({
      run_id: 'run_a', equipment_id: 'ahu_a', uuid: UUID, layer: LAYER, value: 150,
    });
    assert.equal(second.ok, false);
    assert.equal((await client.readPriorityArray({ uuid: UUID }))[7], 0);
    const open = ledger.openOverrides();
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, 'active');
    assert.equal(open[0].value, 0);
  } finally {
    await fake.close();
  }
});

test('the dry-run writer refuses a live ledger entry', async () => {
  const ledger = new Ledger(tempDir());
  const writer = new DryRunWriter(ledger);
  await assert.rejects(
    () => writer.release([{ backend: 'bacnet_direct', uuid: UUID, priority: 8, run_id: 'run_a' }]),
    (error) => error instanceof Error && /** @type {any} */ (error).code === 'dry_run_release_refused',
  );
});

test('dry-run and unconfirmed live mode perform zero writes', async () => {
  const { fake, client, ledger } = await rig();
  try {
    let writes = 0;
    client.writeInCommand = async () => { writes += 1; return { writes: [], errors: [] }; };
    client.bacnetWrite = async () => { writes += 1; return { results: [], errors: [] }; };
    const spec = { run_id: 'run_a', equipment_id: 'ahu_a', uuid: UUID, layer: LAYER, priority: 8, value: 0 };
    for (const config of [{ ...LIVE, dry_run: true }, { ...LIVE, dry_run: false }]) {
      const confirmLive = config.dry_run === true;
      const writer = createWriter({ config, confirmLive, client, ledger });
      await writer.write(spec);
      if (writer instanceof DryRunWriter) {
        await writer.extend(spec, new Date(fake.clock.now() + 60000).toISOString());
      }
    }
    const result = await releaseEntries({
      ledger,
      writer: createWriter({ config: { ...LIVE, dry_run: true }, confirmLive: false, client, ledger }),
      entries: ledger.openOverrides(),
      retries: 0,
      backoff_s: [5],
      sleep: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(writes, 0);
    assert.equal(ledger.openOverrides().length, 0);
    assert.equal((await client.readPriorityArray({ uuid: UUID }))[7], null);
  } finally {
    await fake.close();
  }
});

test('release leaves a slot that no longer holds our value', async () => {
  const { fake, client, ledger } = await rig();
  try {
    const writer = new BacnetDirectWriter({ client, ledger, priority: 8 });
    assert.equal((await writer.write({
      run_id: 'run_a', equipment_id: 'ahu_a', uuid: UUID, layer: LAYER, value: 0,
    })).ok, true);
    await client.bacnetWrite({ uuid: UUID, priority: 8, value: 55 });
    const result = await releaseEntries({
      ledger,
      writer,
      entries: ledger.openOverrides(),
      retries: 0,
      backoff_s: [1],
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal((await client.readPriorityArray({ uuid: UUID }))[7], 55);
    assert.equal(ledger.openOverrides().length, 1);
  } finally {
    await fake.close();
  }
});

test('a failed cancel is not recorded as a verified release', async () => {
  const { fake, client, ledger } = await rig();
  try {
    const writer = new NfCommandWriter({ client, ledger, priority: 8, duration_s: 300 });
    assert.equal((await writer.write({
      run_id: 'run_a', equipment_id: 'ahu_a', uuid: UUID, layer: LAYER, value: 0,
    })).ok, true);
    client.cancelCommand = async () => {
      throw Object.assign(new Error('status 503'), { status: 503 });
    };
    const result = await releaseEntries({
      ledger,
      writer,
      entries: ledger.openOverrides(),
      retries: 0,
      backoff_s: [1],
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(ledger.openOverrides().length, 1);
    assert.equal((await client.listCommands()).commands.length, 1);
    assert.equal((await client.readPriorityArray({ uuid: UUID }))[7], 0);
  } finally {
    await fake.close();
  }
});

test('an unreadable priority array is not an empty slot', () => {
  assert.equal(parsePriorityArray({ value: [] }), 'unreadable');
  const typed = Array(16).fill(null);
  typed[7] = { real: 4 };
  const parsed = parsePriorityArray(typed);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[7], 4);
  typed[7] = { weird: true };
  assert.equal(parsePriorityArray(typed), 'unreadable');
  assert.equal(parsePriorityArray(typed.slice(0, 4)), 'unreadable');
});

test('bacnet_direct nulls only our slot and an offline release ends in NEEDS_ATTENTION', async () => {
  const { fake, client, ledger } = await rig();
  try {
    await client.bacnetWrite({ uuid: UUID, priority: 5, value: 40 });
    const writer = new BacnetDirectWriter({ client, ledger, priority: 8 });
    assert.equal((await writer.write({
      run_id: 'run_a', equipment_id: 'ahu_a', uuid: UUID, layer: LAYER, value: 10,
    })).ok, true);
    const sleeps = [];
    fake.points.get(UUID).offline = true;
    const blocked = await releaseEntries({
      ledger,
      writer,
      entries: ledger.openOverrides(),
      retries: 1,
      backoff_s: [5, 10],
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(blocked.needsAttention, true);
    assert.deepEqual(sleeps, [5000]);
    fake.points.get(UUID).offline = false;
    const cleared = await releaseEntries({
      ledger,
      writer,
      entries: ledger.openOverrides(),
      retries: 1,
      backoff_s: [5],
      sleep: async () => {},
    });
    assert.equal(cleared.ok, true);
    const slots = await client.readPriorityArray({ uuid: UUID });
    assert.equal(slots[7], null);
    assert.equal(slots[4], 40);
  } finally {
    await fake.close();
  }
});

test('recovery releases an intent with no result and cancels an orphan ftest command', async () => {
  const { fake, client, ledger } = await rig();
  try {
    const writer = new NfCommandWriter({ client, ledger, priority: 8, duration_s: 300 });
    await writer.write({ run_id: 'run_a', equipment_id: 'ahu_a', uuid: UUID, layer: LAYER, value: 0 });
    await writer.extend(
      { run_id: 'run_a', equipment_id: 'ahu_a' },
      new Date(fake.clock.now() + 120000).toISOString(),
    );
    const failed = await writer.write({
      run_id: 'run_a', equipment_id: 'ahu_a', uuid: OTHER, layer: LAYER, value: 150,
    });
    assert.equal(failed.ok, false);
    const started = writer.commands.get('ftest-run_a-ahu_a');
    assert.ok(started);
    await client.cancelCommand(started.id);
    const orphan = await client.startCommand({ name: 'ftest-run_b-ahu_a', duration: '120s' });
    await client.writeInCommand({
      command_id: orphan.id,
      writes: [{
        point: { uuid: OTHER, layer: LAYER },
        priority: 8,
        value: { real: 5 },
      }],
    });
    ledger.append({
      kind: 'intent',
      run_id: 'run_c',
      equipment_id: 'ahu_a',
      uuid: UUID,
      layer: LAYER,
      priority: 8,
      value: 15,
      backend: 'nf_command',
      command_name: 'ftest-run_c-ahu_a',
    });
    await client.bacnetWrite({ uuid: UUID, priority: 8, value: 15 });
    ledger.append({
      kind: 'period_intent',
      run_id: 'run_a',
      uuid: OTHER,
      layer: LAYER,
      original_period: 300,
    });

    const result = await recover({
      ledger,
      writers: { nf_command: writer },
      client,
      retries: 2,
      backoff_s: [5, 10],
      sleep: async () => {},
    });
    assert.equal(result.needsAttention, true);
    assert.equal(result.open.length, 1);
    assert.equal(result.open[0].value, 15);
    assert.equal((await client.readPriorityArray({ uuid: UUID }))[7], 15);
    assert.equal((await client.readPriorityArray({ uuid: OTHER }))[7], null);
    assert.equal((await client.listCommands()).commands.length, 0);
    assert.equal(ledger.openPeriods().length, 0);
    const missing = await recover({
      ledger,
      writers: {},
      client,
      retries: 0,
      backoff_s: [5],
      sleep: async () => {},
    });
    assert.equal(missing.needsAttention, true);
  } finally {
    await fake.close();
  }
});

test('a missing writer for an open override is NEEDS_ATTENTION', async () => {
  const ledger = new Ledger(tempDir('orphan-'));
  ledger.append({
    kind: 'active',
    run_id: 'run_a',
    equipment_id: 'ahu_a',
    uuid: UUID,
    layer: LAYER,
    priority: 8,
    backend: 'nf_command',
  });
  const result = await recover({
    ledger,
    writers: {},
    client: null,
    retries: 0,
    backoff_s: [5],
    sleep: async () => {},
  });
  assert.equal(result.needsAttention, true);
  assert.equal(result.open.length, 1);
});
