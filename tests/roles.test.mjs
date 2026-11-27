import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getRole, listRoles, isKnownRole, roleAllowsWrite, valueInClamp } = require('../hooks/lib/roles');

/**
 * @param {string} id
 */
function must(id) {
  const role = getRole(id);
  if (!role) throw new Error(`missing role ${id}`);
  return role;
}

test('registry covers the design role tables', () => {
  const roles = listRoles();
  assert.equal(roles.length, 29);
  const ids = new Set(roles.map((role) => role.id));
  assert.equal(ids.size, roles.length);
  for (const role of roles) {
    assert.equal(getRole(role.id), role);
    assert.equal(isKnownRole(role.id), true);
    assert.ok(['read', 'write', 'readwrite'].includes(role.direction));
    const kinds = Array.isArray(role.equipment) ? role.equipment : [role.equipment];
    assert.ok(kinds.every((kind) => kind === 'ahu' || kind === 'vav'));
    assert.ok(role.unit.length > 0);
  }
  assert.equal(isKnownRole('supply_fan_speed'), false);
});

test('write direction matches the allow-list rule', () => {
  assert.equal(roleAllowsWrite(must('outdoor_air_intake_damper_position_command')), true);
  assert.equal(roleAllowsWrite(must('discharge_air_volume_flow_rate_setpoint')), true);
  assert.equal(roleAllowsWrite(must('supply_fan_command')), false);
  assert.equal(roleAllowsWrite(must('supply_fan_operating_status')), false);
});

test('proposed roles are marked ftest', () => {
  const proposed = [
    'outdoor_air_intake_damper_position_command',
    'return_damper_position_command',
    'cooling_valve_position_command',
    'heating_valve_position_command',
    'test_operating_mode_command',
    'air_temperature_low_limit_alarm_status',
    'air_smoke_alarm_status',
    'maximum_cooling_operating_mode_command',
    'discharge_air_volume_flow_rate_maximum',
    'purge_operating_mode_command',
  ];
  for (const id of proposed) assert.equal(must(id).ftest, true);
  assert.equal(must('discharge_air_temperature').ftest, false);
});

test('percent clamps are 0 to 100', () => {
  const role = must('outdoor_air_intake_damper_position_command');
  assert.deepEqual(valueInClamp(role, 0), { ok: true });
  assert.deepEqual(valueInClamp(role, 100), { ok: true });
  assert.equal(valueInClamp(role, -0.1).ok, false);
  assert.equal(valueInClamp(role, 100.1).ok, false);
  assert.equal(valueInClamp(role, '100').ok, false);
});

test('airflow clamp respects the caller cap', () => {
  const role = must('discharge_air_volume_flow_rate_setpoint');
  assert.equal(valueInClamp(role, 0.2).ok, true);
  assert.equal(valueInClamp(role, 0.2, { airflowMax: 0.1 }).ok, false);
  assert.equal(valueInClamp(role, 0.05, { airflowMax: 0.1 }).ok, true);
  assert.equal(valueInClamp(role, -1).ok, false);
});

test('enum and bool clamps', () => {
  const mode = must('test_operating_mode_command');
  assert.equal(valueInClamp(mode, 2, { enumValues: [1, 2] }).ok, true);
  assert.equal(valueInClamp(mode, 3, { enumValues: [1, 2] }).ok, false);
  const fan = must('supply_fan_operating_status');
  assert.equal(valueInClamp(fan, true).ok, true);
  assert.equal(valueInClamp(fan, 0).ok, true);
  assert.equal(valueInClamp(fan, 2).ok, false);
  const toggle = must('maximum_cooling_operating_mode_command');
  assert.equal(valueInClamp(toggle, true).ok, true);
  assert.equal(valueInClamp(toggle, 4).ok, false);
  const command = must('supply_fan_command');
  assert.equal(valueInClamp(command, false).ok, true);
  assert.equal(valueInClamp(command, 40).ok, false);
});
