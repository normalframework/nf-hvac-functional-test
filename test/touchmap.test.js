'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../static/js/core/touchmap.js');
const demo = require('../static/js/demo-data.js');
const { build } = require('../scripts/build-demo');
const { getRole } = require('../lib/roles');

test('demo fixture is generated from the planner and is current', async () => {
  const fs = require('node:fs');
  assert.equal(fs.readFileSync('static/js/demo-data.js', 'utf8'), await build());
});

test('the demo plan maps device by device with read and written roles', () => {
  const map = M.build(demo.preview);
  const ahu = map.devices[0];
  assert.equal(ahu.type, 'ahu');
  assert.ok(map.devices.slice(1).every((d) => d.type === 'vav'));
  const cooling = /** @type {any} */ (ahu.points.find((p) => p.role === 'cooling_valve_position_command'));
  assert.equal(cooling.mode, 'write');
  assert.equal(cooling.stage, 'coils');
  assert.deepEqual(cooling.writes.map((w) => w.step_id), ['ahu.recirc', 'ahu.economizer']);
  assert.equal(cooling.writes[0].starts_after_ms, 300000);
  assert.equal(cooling.release.priority, 8);
  const damper = /** @type {any} */ (ahu.points.find((p) => p.role === 'outdoor_air_intake_damper_position_command'));
  assert.deepEqual(damper.writes.map((w) => w.value), [0, 100]);
  assert.equal(damper.stage, 'outdoor');
  assert.equal(ahu.points.find((p) => p.role === 'mixed_air_temperature').mode, 'read');
  const box = /** @type {any} */ (map.devices.find((d) => d.equipment_id === 'vav_01'));
  const purge = box.points.find((p) => p.role === 'purge_operating_mode_command');
  assert.equal(purge.mode, 'write');
  assert.equal(purge.stage, 'zones');
  assert.equal(map.total_ms, 300000 + 1200000 * 2 + 1800000 + 600000);
  assert.equal(map.dry_run, true);
  // Role names are the shared role vocabulary, not point names.
  for (const device of map.devices) {
    for (const p of device.points) assert.ok(getRole(p.role), p.role);
  }
});

test('stage rules and empty input', () => {
  assert.equal(M.stageOf('return_air_temperature', 'ahu'), 'return');
  assert.equal(M.stageOf('mixed_air_temperature', 'ahu'), 'mixing');
  assert.equal(M.stageOf('supply_fan_operating_status', 'ahu'), 'fan');
  assert.equal(M.stageOf('discharge_air_static_pressure', 'ahu'), 'discharge');
  assert.equal(M.stageOf('air_smoke_alarm_status', 'ahu'), 'safety');
  assert.equal(M.stageOf('filter_differential_pressure', 'ahu'), 'filter');
  assert.equal(M.stageOf('something_else', 'ahu'), 'control');
  const empty = M.build(null);
  assert.deepEqual(empty.devices, []);
  assert.equal(empty.priority, 8);
  assert.equal(empty.lease_s, null);
  const skipped = M.build({ plan: { equipment_id: 'a', steps: [{ step_id: 'ahu.economizer', status: 'skipped', skip_reason: 'disabled' }], sample_points: [] }, steps: [], priority: 10, lease_s: 300, dry_run: false });
  assert.deepEqual(skipped.skipped, [{ step_id: 'ahu.economizer', reason: 'disabled' }]);
  assert.equal(skipped.dry_run, false);
});
