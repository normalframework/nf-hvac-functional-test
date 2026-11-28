import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateHook } = require('../hooks/lib/hooks/schema');

test('hook definitions match the scheduled and on-request shapes', () => {
  const tick = JSON.parse(fs.readFileSync('hooks-update/tick.json', 'utf8'));
  const admin = JSON.parse(fs.readFileSync('hooks-update/admin.json', 'utf8'));
  const sim = JSON.parse(fs.readFileSync('hooks-update/sim.json', 'utf8'));
  assert.equal(validateHook(tick, 'scheduled').ok, true);
  assert.equal(validateHook(admin, 'request').ok, true);
  assert.equal(validateHook(sim, 'scheduled').ok, true);
  assert.equal(validateHook({ name: 'tick', mode: 'MODE_RRULE' }, 'scheduled').ok, false);
  assert.equal(validateHook({ hook: { name: 'tick', entryPoint: 'hooks/tick.js', mode: 'MODE_RRULE', invokeTimeout: '8s' } }, 'scheduled').ok, false);
});

test('scheduled hooks are staggered so tick, sim, and trigger cannot overlap', () => {
  const tick = JSON.parse(fs.readFileSync('hooks-update/tick.json', 'utf8'));
  const sim = JSON.parse(fs.readFileSync('hooks-update/sim.json', 'utf8'));
  const trigger = JSON.parse(fs.readFileSync('hooks-update/trigger.json', 'utf8'));
  assert.match(tick.hook.schedule.rrule, /DTSTART:20260101T000000Z/);
  assert.match(tick.hook.schedule.rrule, /FREQ=SECONDLY;INTERVAL=30/);
  assert.equal(tick.hook.invokeTimeout, '8s');
  assert.match(sim.hook.schedule.rrule, /DTSTART:20260101T000008Z/);
  assert.match(sim.hook.schedule.rrule, /FREQ=MINUTELY;INTERVAL=2/);
  assert.equal(sim.hook.invokeTimeout, '20s');
  assert.match(trigger.hook.schedule.rrule, /DTSTART:20260101T000040Z/);
  assert.match(trigger.hook.schedule.rrule, /FREQ=MINUTELY;INTERVAL=1/);
  assert.equal(tick.hook.runtimeConfig.memoryLimit, 64);
  assert.equal(sim.hook.runtimeConfig.memoryLimit, 96);
  assert.equal(trigger.hook.runtimeConfig.memoryLimit, 64);
  const admin = JSON.parse(fs.readFileSync('hooks-update/admin.json', 'utf8'));
  assert.equal(admin.hook.runtimeConfig.memoryLimit, 64);
});
