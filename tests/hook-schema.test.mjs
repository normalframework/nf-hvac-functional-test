import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateHook } = require('../hooks/lib/hooks/schema');

test('hook definitions match the scheduled and on-request shapes', () => {
  const tick = JSON.parse(fs.readFileSync('hooks-update/tick.json', 'utf8'));
  const admin = JSON.parse(fs.readFileSync('hooks-update/admin.json', 'utf8'));
  assert.equal(validateHook(tick, 'scheduled').ok, true);
  assert.equal(validateHook(admin, 'request').ok, true);
  assert.equal(validateHook({ name: 'tick', mode: 'MODE_RRULE' }, 'scheduled').ok, false);
  assert.equal(validateHook({ hook: { name: 'tick', entryPoint: 'hooks/tick.js', mode: 'MODE_RRULE', invokeTimeout: '8s' } }, 'scheduled').ok, false);
});
