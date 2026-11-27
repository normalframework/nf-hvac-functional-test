import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration, parseDurationMs } = require('../hooks/lib/nf/duration');

test('duration strings cover seconds, minutes, hours, and rejection', () => {
  assert.equal(formatDuration(300), '300s');
  assert.throws(() => formatDuration(0), /positive integer/);
  assert.throws(() => formatDuration(1.5), /positive integer/);
  assert.equal(parseDurationMs('250ms'), 250);
  assert.equal(parseDurationMs('2m'), 120000);
  assert.equal(parseDurationMs('1h'), 3600000);
  assert.equal(Number.isNaN(parseDurationMs(/** @type {any} */ (12))), true);
  assert.equal(Number.isNaN(parseDurationMs('soon')), true);
});
