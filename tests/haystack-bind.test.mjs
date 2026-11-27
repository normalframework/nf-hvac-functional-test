import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('../static/haystack-bind.js');
const vocab = require('../static/roles-223p.js');

const own = vocab.roles.filter((r) => r.haystack && (r.haystack.binding_scope || 'own') === 'own');
const parentOf = (r) => [...r.haystack.equip_markers, 'equip'];

test('parity: each role\'s own tag set binds that role (roles file recipe, step 4)', () => {
  const misses = [];
  for (const r of own) {
    const markers = [...r.haystack.markers, ...r.haystack.custom_markers];
    const got = B.bindPoint({ markers }, parentOf(r), vocab);
    if (got.role !== r.role) misses.push(`${r.role} -> ${got.role} (${got.candidates.join(', ')})`);
  }
  assert.deepEqual(misses, []);
});

test('parity: a point carrying another role\'s tags never binds a writable role', () => {
  const writable = new Set(vocab.roles.filter((r) => r.writable === 'model').map((r) => r.role));
  for (const r of own) {
    const got = B.bindPoint({ markers: [...r.haystack.markers, ...r.haystack.custom_markers] }, parentOf(r), vocab);
    if (got.role && writable.has(got.role)) assert.equal(got.role, r.role);
  }
});

test('forbid, function marker and parent constraints', () => {
  assert.equal(B.bindPoint({ markers: ['damper', 'cmd', 'outside'] }, ['vav'], vocab).role, 'outdoor_air_intake_damper_position_command');
  assert.equal(B.bindPoint({ markers: ['damper', 'cmd', 'sensor'] }, ['vav'], vocab).role, null, 'two function markers');
  assert.equal(B.bindPoint({ markers: ['reheat', 'cmd'] }, ['ahu'], vocab).role, null, 'reheat needs an air terminal parent');
  assert.equal(B.bindPoint({ markers: ['discharge', 'air', 'temp', 'sensor'] }, ['ahu'], vocab).role, 'discharge_air_temperature');
  assert.equal(B.bindPoint({ markers: ['discharge', 'air', 'temp', 'sensor'] }, ['vav', 'airTerminalUnit'], vocab).role, 'terminal_unit_discharge_air_temperature');
  assert.equal(B.bindPoint({ markers: [], cls: 'damper-cmd' }, ['vav'], vocab).role, 'damper_position_command', 'NF class binds');
  assert.equal(B.bindPoint({ markers: ['sensor'], cls: 'damper-cmd' }, ['vav'], vocab).role, null, 'class still obeys the function marker');
  assert.equal(B.bindPoint({ markers: ['mystery', 'sensor'] }, [], vocab).role, null);
  assert.equal(B.functionMarker({ haystack: { markers: [] }, s223: { property_class: 's223:QuantifiableActuatableProperty', aspects: ['s223:Aspect-Setpoint'] } }, ['sensor', 'sp', 'cmd']), 'sp');
});

test('equipment binding: optional markers break duplicates, a remaining tie is reported', () => {
  const r = B.bindEquipment([
    { id: 'a', markers: ['air', 'flow', 'sensor'] },
    { id: 'b', markers: ['air', 'flow', 'sensor', 'discharge'] },
    { id: 'c', markers: ['damper', 'cmd'] },
    { id: 'd', markers: ['damper', 'cmd'] },
    { id: 'e', markers: ['nothing'] },
  ], ['vav', 'airTerminalUnit'], vocab);
  assert.equal(r.bound.b, 'discharge_air_volume_flow_rate');
  assert.equal(r.bound.a, undefined);
  assert.deepEqual(r.duplicates, [{ role: 'damper_position_command', points: ['c', 'd'] }]);
  assert.deepEqual(r.unbound, ['e']);
});
