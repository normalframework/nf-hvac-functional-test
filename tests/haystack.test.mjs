import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadHaystackModel, pointTags, matchRoleResult } = require('../hooks/lib/model/haystack');
const { loadHaystackMap, mergeMaps } = require('../hooks/lib/model/map');

const MAP = loadHaystackMap();

/**
 * @param {string[]} tags
 * @param {Record<string, string>} [attrs]
 */
function tagged(tags, attrs = {}) {
  /** @type {Record<string, string>} */
  const record = { equipRef: 'ahu_a', ...attrs };
  for (const tag of tags) record[tag] = 'm:';
  return {
    uuid: '00000000-0000-4000-8000-000000000201',
    layer: 'hpl:bacnet:1',
    attrs: record,
  };
}

/**
 * @param {any} point
 */
function roleOf(point, type = 'ahu') {
  const model = loadHaystackModel({
    equipment: [{ id: 'ahu_a', type }],
    points: [point],
  });
  const points = model.equipment.find((item) => item.id === 'ahu_a').points;
  return { points, ambiguous: model.ambiguous, rejected: model.rejected };
}

test('cmd forces a command role and a tie is reported instead of guessed', () => {
  const fan = roleOf(tagged(['supply', 'fan', 'run', 'cmd']));
  assert.equal(fan.points.supply_fan_command.role, 'supply_fan_command');
  assert.equal(fan.points.supply_fan_operating_status, undefined);
  assert.equal(fan.ambiguous.length, 0);

  const tiedMap = mergeMaps(MAP, {
    version: 1,
    roles: [{ role: 'test_operating_mode_command', tags: ['fan', 'cmd', 'run'] }],
  });
  const tags = pointTags(tagged(['supply', 'fan', 'run', 'cmd']));
  const tied = matchRoleResult(tags, tiedMap);
  assert.equal(tied.entry, null);
  assert.equal(tied.ambiguous, true);
  assert.deepEqual(tied.roles.slice().sort(), ['supply_fan_command', 'test_operating_mode_command']);

  const loaded = loadHaystackModel({
    equipment: [{ id: 'ahu_a', type: 'ahu' }],
    points: [tagged(['supply', 'fan', 'run', 'cmd'])],
  }, tiedMap);
  assert.equal(loaded.equipment[0].points.supply_fan_command, undefined);
  assert.equal(loaded.equipment[0].points.test_operating_mode_command, undefined);
  assert.equal(loaded.ambiguous.length, 1);
  assert.deepEqual(loaded.ambiguous[0].roles.slice().sort(), ['supply_fan_command', 'test_operating_mode_command']);
});

test('max or min airflow cannot bind to the writable setpoint', () => {
  const capped = roleOf(tagged(['max', 'air', 'flow', 'sp', 'writable']), 'vav');
  assert.equal(capped.points.discharge_air_volume_flow_rate_setpoint, undefined);
  assert.equal(capped.points.discharge_air_volume_flow_rate_maximum.role, 'discharge_air_volume_flow_rate_maximum');

  const minimum = roleOf(tagged(['min', 'air', 'flow', 'sp', 'writable']), 'vav');
  assert.equal(minimum.points.discharge_air_volume_flow_rate_setpoint, undefined);

  const setpoint = roleOf(tagged(['air', 'flow', 'sp', 'writable']), 'vav');
  assert.equal(setpoint.points.discharge_air_volume_flow_rate_setpoint.writable, true);
  const maximum = roleOf(tagged(['max', 'air', 'flow', 'sp']), 'vav');
  assert.equal(maximum.points.discharge_air_volume_flow_rate_maximum.writable, false);
});

test('two points with the same role on one equipment bind neither', () => {
  const first = tagged(['discharge', 'air', 'temp', 'sensor']);
  const second = tagged(['discharge', 'air', 'temp', 'sensor'], { uuid: '00000000-0000-4000-8000-000000000299' });
  second.uuid = '00000000-0000-4000-8000-000000000299';
  const model = loadHaystackModel({
    equipment: [{ id: 'ahu_a', type: 'ahu' }],
    points: [first, second],
  });
  assert.equal(model.equipment[0].points.discharge_air_temperature, undefined);
  assert.equal(model.ambiguous.length, 1);
});

test('class and comma-separated markers are tags, including Haystack 4 names', () => {
  const fromMarkers = roleOf({
    uuid: '00000000-0000-4000-8000-000000000202',
    layer: 'hpl:bacnet:1',
    attrs: {
      class: 'point',
      markers: 'cool, valve, cmd, writable',
      equipRef: 'ahu_a',
    },
  });
  assert.equal(fromMarkers.points.cooling_valve_position_command.writable, true);

  const fromClass = roleOf({
    uuid: '00000000-0000-4000-8000-000000000203',
    layer: 'hpl:bacnet:1',
    attrs: {
      class: 'freezeStat',
      markers: 'sensor',
      equipRef: 'ahu_a',
    },
  });
  assert.equal(fromClass.points.air_temperature_low_limit_alarm_status.role, 'air_temperature_low_limit_alarm_status');

  const duct = roleOf({
    uuid: '00000000-0000-4000-8000-000000000204',
    layer: 'hpl:bacnet:1',
    attrs: {
      class: 'sensor',
      markers: 'discharge,air,pressure,sensor',
      equipRef: 'ahu_a',
    },
  });
  assert.equal(duct.points.discharge_air_static_pressure.role, 'discharge_air_static_pressure');

  const vav = loadHaystackModel({
    equipment: [{ id: 'vav_01', type: 'vav' }],
    points: [tagged(['discharge', 'air', 'temp', 'sensor'], { equipRef: 'vav_01' })],
  });
  assert.equal(vav.equipment[0].points.discharge_air_temperature, undefined);
  assert.equal(vav.rejected[0].role, 'discharge_air_temperature');

  const dashed = roleOf({
    uuid: '00000000-0000-4000-8000-000000000205',
    layer: 'hpl:bacnet:1',
    attrs: { class: 'discharge-air-temp-sensor', equipRef: 'ahu_a' },
  });
  assert.equal(dashed.points.discharge_air_temperature.role, 'discharge_air_temperature');

  const damper = roleOf(tagged(['outside', 'damper', 'cmd', 'writable']));
  assert.equal(damper.points.outdoor_air_intake_damper_position_command.role, 'outdoor_air_intake_damper_position_command');
  const withAir = roleOf(tagged(['outside', 'air', 'damper', 'cmd', 'writable']));
  assert.equal(withAir.points.outdoor_air_intake_damper_position_command.role, 'outdoor_air_intake_damper_position_command');
});
