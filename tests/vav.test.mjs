import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { airflowTarget } = require('../hooks/lib/vav/airflow_setpoint');
const { flushEffective } = require('../hooks/lib/vav/flush_point');
const { basToggleEffect } = require('../hooks/lib/vav/bas_toggle');
const { executeVav, orderRelease } = require('../hooks/lib/vav/execute');
const { applyDefaults } = require('../hooks/lib/config/defaults');

const config = applyDefaults({
  version: 1,
  vav_test: {
    batch_size: 1,
    batch_delay_s: 20,
    airflow_setpoint_default_m3s: 0.4,
    airflow_setpoint_hard_cap_m3s: 0.3,
    bas_toggle_min_boxes_responding_pct: 60,
  },
});

test('setpoint, flush, and bas toggle decisions', () => {
  assert.equal(airflowTarget({ maximum: 0.5, fallback: 0.2, hardCap: 0.3 }).value, 0.3);
  assert.equal(airflowTarget({ maximum: null, fallback: null, hardCap: null }).ok, false);
  assert.equal(flushEffective({ flush: 1, readback: 1 }).ok, true);
  assert.equal(flushEffective({ flush: 1, readback: null }).reason, 'write_not_effective');
  assert.equal(basToggleEffect({ responding: 1, total: 4, minimumPct: 60 }).reason, 'no_effect');
  assert.equal(basToggleEffect({ responding: 3, total: 4, minimumPct: 60 }).ok, true);
  assert.deepEqual(
    orderRelease([
      { equipment_id: 'ahu_a', uuid: 'a' },
      { equipment_id: 'vav_02', uuid: 'b' },
      { equipment_id: 'vav_01', uuid: 'c' },
    ], 'ahu_a').map((entry) => entry.equipment_id),
    ['vav_01', 'vav_02', 'ahu_a'],
  );
});

test('boxes are written in batches and a dead readback is not treated as success', async () => {
  const writes = [];
  const sleeps = [];
  const points = new Map([
    ['vav_01|purge_operating_mode_command', { uuid: 'u1', layer: 'hpl:bacnet:1' }],
    ['vav_02|purge_operating_mode_command', { uuid: 'u2', layer: 'hpl:bacnet:1' }],
    ['vav_03|discharge_air_volume_flow_rate_setpoint', { uuid: 'u3', layer: 'hpl:bacnet:1' }],
    ['ahu_a|maximum_cooling_operating_mode_command', { uuid: 'u4', layer: 'hpl:bacnet:1' }],
  ]);
  const writer = {
    write: async (spec) => {
      writes.push(spec.equipment_id);
      return { ok: true };
    },
  };
  const flushed = await executeVav({
    step: {
      boxes: [
        { equipment_id: 'vav_01', strategy: 'flush_point' },
        { equipment_id: 'vav_02', strategy: 'flush_point' },
      ],
    },
    config,
    writer,
    runId: 'run_v',
    ahuId: 'ahu_a',
    sleep: async (ms) => { sleeps.push(ms); },
    pointFor: (id, role) => points.get(`${id}|${role}`) || null,
    readSlot: async () => 1,
    readNumber: async () => null,
  });
  assert.equal(flushed.ok, true);
  assert.deepEqual(sleeps, [20000]);
  assert.deepEqual(writes, ['vav_01', 'vav_02']);

  const ignored = await executeVav({
    step: { boxes: [{ equipment_id: 'vav_03', strategy: 'airflow_setpoint' }] },
    config,
    writer,
    runId: 'run_v',
    ahuId: 'ahu_a',
    sleep: async () => {},
    pointFor: (id, role) => points.get(`${id}|${role}`) || null,
    readSlot: async () => null,
    readNumber: async () => 0.5,
  });
  assert.equal(ignored.report[0].reason, 'write_not_effective');

  const toggle = await executeVav({
    step: { boxes: [{ equipment_id: 'vav_01', strategy: 'bas_toggle' }, { equipment_id: 'vav_02', strategy: 'bas_toggle' }] },
    config,
    writer,
    runId: 'run_v',
    ahuId: 'ahu_a',
    sleep: async () => {},
    pointFor: (id, role) => points.get(`${id}|${role}`) || null,
    readSlot: async () => 1,
    readNumber: async () => 0.1,
  });
  assert.ok(toggle.report.every((row) => row.reason === 'no_effect'));
  assert.equal(writes.includes('ahu_a'), true);
});
