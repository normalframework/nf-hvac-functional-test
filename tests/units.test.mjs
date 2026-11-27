import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convertToSi, convertFromSi, deviceNumber } = require('../hooks/lib/units');

test('converts common unit tokens to SI', () => {
  const temp = convertToSi(32, 'degF', 'DEG_C');
  assert.equal(temp.ok, true);
  if (temp.ok) assert.ok(Math.abs(temp.value) < 1e-9);
  const flow = convertToSi(1000, 'cfm', 'L-PER-SEC');
  assert.equal(flow.ok, true);
  if (flow.ok) assert.ok(Math.abs(flow.value - 471.9474432) < 1e-6);
  const pressure = convertToSi(1, 'inH2O', 'PA');
  assert.equal(pressure.ok, true);
  if (pressure.ok) assert.ok(pressure.value > 249 && pressure.value < 250);
  assert.deepEqual(convertToSi(21.5, 'degC', 'DEG_C'), { ok: true, value: 21.5, unit: 'DEG_C' });
  assert.deepEqual(convertToSi(10, 'L/s', 'L-PER-SEC'), { ok: true, value: 10, unit: 'L-PER-SEC' });
});

test('writes convert SI back to the device unit', () => {
  const fahrenheit = convertFromSi(0, 'degF', 'DEG_C');
  assert.equal(fahrenheit.ok, true);
  if (fahrenheit.ok) assert.ok(Math.abs(fahrenheit.value - 32) < 1e-9);
  const flow = deviceNumber({ role: 'discharge_air_volume_flow_rate', unit: 'cfm' }, 0.4);
  assert.equal(flow.ok, true);
  if (flow.ok && typeof flow.value === 'number') assert.ok(Math.abs(flow.value - (0.4 / 0.4719474432)) < 1e-6);
  assert.deepEqual(deviceNumber({ role: 'discharge_air_static_pressure', unit: 'furlong' }, 10), { ok: false, reason: 'unknown_unit' });
});

test('unknown or mismatched units fail closed', () => {
  assert.deepEqual(convertToSi(1, 'furlong', 'L-PER-SEC'), { ok: false, reason: 'unknown_unit' });
  assert.deepEqual(convertToSi(1, 'degF', 'PA'), { ok: false, reason: 'unit_mismatch' });
  assert.deepEqual(convertToSi('12', 'degC', 'DEG_C'), { ok: false, reason: 'not_a_number' });
  assert.deepEqual(convertToSi(Number.NaN, 'Pa', 'PA'), { ok: false, reason: 'not_a_number' });
});
