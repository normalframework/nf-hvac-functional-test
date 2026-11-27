import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('./fixtures/fake/server');
const { VirtualClock } = require('./fixtures/fake/clock');
const { NfClient } = require('../hooks/lib/nf/client');

const LAYER = 'hpl:bacnet:1';

/**
 * @param {NfClient} client
 * @param {string} uuid
 * @param {number} priority
 * @param {number | boolean | null} value
 * @param {number} commandId
 */
function writeAt(client, uuid, priority, value, commandId) {
  return client.writeInCommand({
    command_id: commandId,
    cancel_on_conflict: true,
    writes: [{
      point: { uuid, layer: LAYER },
      priority,
      value: typeof value === 'number' ? { real: value } : { boolean: value },
    }],
  });
}

async function fixture() {
  const clock = new VirtualClock(Date.parse('2026-01-01T00:00:00Z'));
  const fake = await createFake({ clock });
  const client = new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} });
  return { fake, client, clock };
}

test('command expiry clears the priority slot and offline expiry becomes a zombie', async () => {
  const { fake, client, clock } = await fixture();
  try {
    const damper = '00000000-0000-4000-8000-0000000000a1';
    const stuck = '00000000-0000-4000-8000-0000000000a2';
    fake.seedAhu({
      points: {
        outdoor_air_intake_damper_position_command: damper,
        cooling_valve_position_command: stuck,
        outdoor_air_intake_temperature: '00000000-0000-4000-8000-0000000000a3',
        return_air_temperature: '00000000-0000-4000-8000-0000000000a4',
        mixed_air_temperature: '00000000-0000-4000-8000-0000000000a5',
        discharge_air_temperature: '00000000-0000-4000-8000-0000000000a6',
      },
      oat: 10,
      rat: 22,
    });
    const started = await client.startCommand({ name: 'ftest-run-a', duration: '300s' });
    const wrote = await writeAt(client, damper, 8, 0, started.id);
    assert.equal(wrote.errors.length, 0);
    let slots = await client.readPriorityArray({ uuid: damper });
    assert.equal(slots[7], 0);
    clock.advance(301 * 1000);
    slots = await client.readPriorityArray({ uuid: damper });
    assert.equal(slots[7], null);
    const listed = await client.listCommands();
    assert.equal(listed.commands.length, 0);

    const again = await client.startCommand({ name: 'ftest-run-b', duration: '60s' });
    await writeAt(client, stuck, 8, 0, again.id);
    fake.points.get(stuck).offline = true;
    clock.advance(61 * 1000);
    fake.points.get(stuck).offline = false;
    const held = await client.readPriorityArray({ uuid: stuck });
    assert.equal(held[7], 0);
    const zombies = await client.listZombies();
    assert.equal(zombies.zombies.some((item) => item.uuid === stuck), true);
  } finally {
    await fake.close();
  }
});

test('priority array keeps other slots and null relinquishes only our slot', async () => {
  const { fake, client } = await fixture();
  try {
    const uuid = '00000000-0000-4000-8000-0000000000b1';
    fake.seedAhu({ points: { outdoor_air_intake_damper_position_command: uuid } });
    await client.bacnetWrite({ uuid, priority: 5, value: 40 });
    await client.bacnetWrite({ uuid, priority: 8, value: 10 });
    let slots = await client.readPriorityArray({ uuid });
    assert.equal(slots.length, 16);
    assert.equal(slots[4], 40);
    assert.equal(slots[7], 10);
    const present = await client.bacnetRead([{ uuid, property: 'PRESENT_VALUE' }]);
    assert.equal(present.results[0].value, 40);
    const cleared = await client.bacnetWrite({ uuid, priority: 8, value: null });
    assert.equal(cleared.errors.length, 0);
    slots = await client.readPriorityArray({ uuid });
    assert.equal(slots[7], null);
    assert.equal(slots[4], 40);
    const rejected = await client.bacnetWrite({ uuid, priority: 1, value: 0 });
    assert.equal(rejected.errors[0].error.code, 'priority_rejected');
    assert.equal((await client.readPriorityArray({ uuid }))[0], null);
  } finally {
    await fake.close();
  }
});

test('unique names, guardrails, conflict, and client retries', async () => {
  const { fake, client } = await fixture();
  try {
    const uuid = '00000000-0000-4000-8000-0000000000c1';
    fake.seedAhu({ points: { cooling_valve_position_command: uuid } });
    const first = await client.startCommand({ name: 'ftest-lock', duration: '120s' });
    await assert.rejects(
      () => client.startCommand({ name: 'ftest-lock', duration: '120s' }),
      (error) => error instanceof Error && /** @type {any} */ (error).status === 409,
    );
    const guard = await writeAt(client, uuid, 8, 150, first.id);
    assert.equal(guard.errors[0].error.code, 'guardrail');
    assert.equal((await client.readPriorityArray({ uuid }))[7], null);
    await writeAt(client, uuid, 8, 0, first.id);

    const second = await client.startCommand({ name: 'ftest-other', duration: '120s' });
    const conflict = await writeAt(client, uuid, 8, 5, second.id);
    assert.equal(conflict.errors[0].error.code, 'conflict');
    assert.equal((await client.readPriorityArray({ uuid }))[7], 0);

    fake.failNext(2, { status: 503 });
    const queried = await client.queryPoints({ uuid });
    assert.equal(queried.points[0].uuid, uuid);

    const extended = new Date(fake.clock.now() + 600 * 1000).toISOString();
    await client.extendCommand(first.id, extended);
    await client.cancelCommand(first.id);
    assert.equal((await client.readPriorityArray({ uuid }))[7], null);
  } finally {
    await fake.close();
  }
});

test('ahu mix and vav profiles stay plausible', async () => {
  const { fake, client } = await fixture();
  try {
    const ids = {
      outdoor_air_intake_temperature: '00000000-0000-4000-8000-0000000000d1',
      return_air_temperature: '00000000-0000-4000-8000-0000000000d2',
      mixed_air_temperature: '00000000-0000-4000-8000-0000000000d3',
      discharge_air_temperature: '00000000-0000-4000-8000-0000000000d4',
      outdoor_air_intake_damper_position_command: '00000000-0000-4000-8000-0000000000d5',
      cooling_valve_position_command: '00000000-0000-4000-8000-0000000000d6',
      supply_fan_operating_status: '00000000-0000-4000-8000-0000000000d7',
    };
    fake.seedAhu({ points: ids, oat: 10, rat: 24, fanOn: true });
    await client.bacnetWrite({ uuid: ids.outdoor_air_intake_damper_position_command, priority: 8, value: 0 });
    const closed = await client.bacnetRead([{ uuid: ids.mixed_air_temperature, property: 'PRESENT_VALUE' }]);
    assert.ok(closed.results[0].value > 23);

    await client.bacnetWrite({ uuid: ids.outdoor_air_intake_damper_position_command, priority: 8, value: 100 });
    const open = await client.bacnetRead([{ uuid: ids.mixed_air_temperature, property: 'PRESENT_VALUE' }]);
    assert.ok(open.results[0].value < 11);

    const box = {
      discharge_air_volume_flow_rate: '00000000-0000-4000-8000-0000000000e1',
      discharge_air_volume_flow_rate_setpoint: '00000000-0000-4000-8000-0000000000e2',
      discharge_air_volume_flow_rate_maximum: '00000000-0000-4000-8000-0000000000e3',
    };
    fake.seedVav({ id: 'vav_01', profile: 'setpoint_readonly', points: box, maxFlow: 0.4 });
    const readonly = await client.bacnetWrite({ uuid: box.discharge_air_volume_flow_rate_setpoint, priority: 8, value: 0.4 });
    assert.equal(readonly.errors[0].error.code, 'not_commandable');

    const writable = {
      discharge_air_volume_flow_rate: '00000000-0000-4000-8000-0000000000e4',
      discharge_air_volume_flow_rate_setpoint: '00000000-0000-4000-8000-0000000000e5',
    };
    fake.seedVav({ id: 'vav_02', profile: 'setpoint_writable', points: writable, maxFlow: 0.4 });
    await client.bacnetWrite({ uuid: writable.discharge_air_volume_flow_rate_setpoint, priority: 8, value: 0.4 });
    const flow = await client.bacnetRead([{ uuid: writable.discharge_air_volume_flow_rate, property: 'PRESENT_VALUE' }]);
    assert.equal(flow.results[0].value, 0.4);

    const ignored = {
      discharge_air_volume_flow_rate: '00000000-0000-4000-8000-0000000000e6',
      discharge_air_volume_flow_rate_setpoint: '00000000-0000-4000-8000-0000000000e7',
    };
    fake.seedVav({ id: 'vav_03', profile: 'setpoint_ignored', points: ignored });
    await client.bacnetWrite({ uuid: ignored.discharge_air_volume_flow_rate_setpoint, priority: 8, value: 0.4 });
    const slot = await client.readPriorityArray({ uuid: ignored.discharge_air_volume_flow_rate_setpoint });
    assert.equal(slot[7], null);

    const overridden = {
      discharge_air_volume_flow_rate: '00000000-0000-4000-8000-0000000000e8',
      discharge_air_volume_flow_rate_setpoint: '00000000-0000-4000-8000-0000000000e9',
    };
    fake.seedVav({ id: 'vav_04', profile: 'higher_priority_override_active', points: overridden, maxFlow: 0.3 });
    const array = await client.readPriorityArray({ uuid: overridden.discharge_air_volume_flow_rate_setpoint });
    assert.equal(array[6], 0.3);

    const upserted = await client.upsertPoints([{
      uuid: '00000000-0000-4000-8000-0000000000f1',
      layer: LAYER,
      type: 'ai',
      role: 'ftest_step_index',
      unit: '',
    }]);
    assert.equal(upserted.points[0].role, 'ftest_step_index');
    const data = await client.addData({ batches: [{ uuid: upserted.points[0].uuid, values: [{ value: 1 }] }] });
    assert.equal(data.accepted, 1);

    const flush = {
      discharge_air_volume_flow_rate: '00000000-0000-4000-8000-0000000000ea',
      purge_operating_mode_command: '00000000-0000-4000-8000-0000000000eb',
    };
    fake.seedVav({ id: 'vav_05', profile: 'flush_capable', points: flush, maxFlow: 0.55 });
    await client.bacnetWrite({ uuid: flush.purge_operating_mode_command, priority: 8, value: true });
    const flushed = await client.bacnetRead([{ uuid: flush.discharge_air_volume_flow_rate, property: 'PRESENT_VALUE' }]);
    assert.equal(flushed.results[0].value, 0.55);

    fake.failNext(1, { drop: true });
    const afterDrop = await client.queryPoints({ uuid: ids.outdoor_air_intake_temperature });
    assert.equal(afterDrop.points.length, 1);
    await assert.rejects(
      () => client.request('/api/v2/command', { method: 'POST', body: { name: 'made-up', duration_s: 30 } }),
      (error) => error instanceof Error && /** @type {any} */ (error).body.error.code === 'unknown_field',
    );
    await assert.rejects(() => client.startCommand({ name: 'too-long', duration: '90000s' }));
  } finally {
    await fake.close();
  }
});
