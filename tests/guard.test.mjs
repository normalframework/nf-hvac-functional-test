import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { guardWrite } = require('../hooks/lib/writers/guard');

test('guardWrite rejects a non-finite value, a clamp miss, and a missing priority array', () => {
  const valve = { role: 'cooling_valve_position_command', writable: true };
  const missing = guardWrite(valve, undefined, null);
  assert.equal(missing.ok, false);
  const nan = guardWrite(valve, Number.NaN, null);
  assert.equal(nan.ok, false);
  if (!nan.ok) assert.equal(nan.reason, 'clamp');
  const high = guardWrite(valve, 150, null);
  assert.equal(high.ok, false);
  if (!high.ok) assert.equal(high.reason, 'clamp');
  const unread = guardWrite(valve, 0, { priority_array: false });
  assert.equal(unread.ok, false);
  if (!unread.ok) assert.equal(unread.reason, 'no_priority_array');
  assert.equal(guardWrite(valve, 0, { priority_array: true }).ok, true);
  const mode = { role: 'test_operating_mode_command', writable: true };
  assert.equal(guardWrite(mode, 1, null).ok, true);
});
