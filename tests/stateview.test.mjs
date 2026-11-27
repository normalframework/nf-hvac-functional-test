import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../static/stateview.js');

const steps = [
  { step_id: 'ahu.baseline', hold_ms: 300000, settle_ms: 0, writes: [] },
  { step_id: 'ahu.recirc', hold_ms: 1200000, settle_ms: 300000, writes: [{ role: 'cooling_valve_position_command', value: 0 }] },
  { step_id: 'recovery', hold_ms: 600000, settle_ms: 0, writes: [] },
];
/** @param {any} v @param {string} id */
const cd = (v, id) => /** @type {any} */ (v.countdowns.find((/** @type {any} */ c) => c.id === id));
/** @param {any} v @param {string} id */
const node = (v, id) => /** @type {any} */ (v.path.find((/** @type {any} */ p) => p.id === id));
const base = { steps, run_started_at: 1000, max_total_ms: 9000000 };

test('idle and scheduled', () => {
  const idle = V.view({ state: 'IDLE' }, { now: 0, triggerMode: 'disabled', nextRunAt: 5000 });
  assert.equal(idle.node, 'IDLE');
  assert.equal(idle.countdowns.length, 0);
  const waiting = V.view({ state: 'IDLE' }, { now: 0, triggerMode: 'dry_run', nextRunAt: 5000 });
  assert.equal(waiting.node, 'SCHEDULED');
  assert.deepEqual(waiting.countdowns[0], { id: 'next_trigger', label: 'Next scheduled run', remaining_ms: 5000, total_ms: 0 });
  assert.match(waiting.detail, /dry-run/);
  assert.match(V.view({ state: 'IDLE' }, { now: 0, triggerMode: 'armed', nextRunAt: 5000 }).detail, /live/);
  assert.deepEqual(waiting.path.map((p) => p.status).slice(0, 3), ['done', 'current', 'todo']);
  assert.equal(V.view(null, { now: 0 }).node, 'IDLE');
});

test('precheck, override, settle, capture, release, report', () => {
  assert.equal(V.view({ ...base, state: 'PRECHECK', step_index: -1 }, { now: 2000 }).node, 'PRECHECK');
  const override = V.view({ ...base, state: 'STEP', step_index: 1, step_started_at: 2000, step_written: false }, { now: 2000 });
  assert.equal(override.node, 'OVERRIDE');
  assert.equal(override.label, 'OVERRIDE_STEP_2 · ahu.recirc');
  assert.deepEqual(override.step, { n: 2, total: 3, step_id: 'ahu.recirc' });
  const settle = V.view({ ...base, state: 'STEP', step_index: 1, step_started_at: 2000, step_written: true }, { now: 62000 });
  assert.equal(settle.node, 'SETTLE');
  assert.equal(cd(settle, 'settle').remaining_ms, 240000);
  assert.equal(cd(settle, 'step').remaining_ms, 1140000);
  assert.ok(cd(settle, 'run_limit'));
  const capture = V.view({ ...base, state: 'STEP', step_index: 1, step_started_at: 2000, step_written: true }, { now: 402000 });
  assert.equal(capture.node, 'CAPTURE');
  assert.equal(V.view({ ...base, state: 'BASELINE', step_index: 0 }, { now: 1 }).node, 'CAPTURE');
  const releasing = V.view({ ...base, state: 'RELEASING', step_index: 1 }, { now: 1 });
  assert.equal(releasing.node, 'RELEASE');
  const recovery = V.view({ ...base, state: 'RECOVERY', step_index: 2, step_started_at: 1000 }, { now: 61000 });
  assert.equal(recovery.node, 'RELEASE');
  assert.equal(cd(recovery, 'recovery').remaining_ms, 540000);
  const pass = V.view({ state: 'COMPLETE', reason: 'complete' }, { now: 0 });
  assert.equal(pass.node, 'REPORT');
  assert.equal(pass.outcome, 'pass');
  assert.match(pass.detail, /completed/);
  assert.equal(V.view({ state: 'FAILED', reason: 'precheck' }, { now: 0 }).outcome, 'fail');
  assert.match(V.view({ state: 'ABORTED' }, { now: 0 }).detail, /aborted/);
});

test('needs attention is off the happy path', () => {
  const stuck = V.view({ state: 'NEEDS_ATTENTION', needs_attention: true }, { now: 0 });
  assert.equal(stuck.node, 'NEEDS_ATTENTION');
  assert.equal(stuck.attention, true);
  assert.equal(node(stuck, 'RELEASE').status, 'current');
  assert.equal(node(stuck, 'REPORT').status, 'todo');
});

test('countdown text', () => {
  assert.equal(V.formatCountdown(0), '0:00');
  assert.equal(V.formatCountdown(61000), '1:01');
  assert.equal(V.formatCountdown(3723000), '1:02:03');
  assert.equal(V.formatCountdown(90061000), '1d 01:01:01');
  assert.equal(V.formatCountdown(NaN), '0:00');
});

test('status from the admin hook carries write counts, not write lists', () => {
  const counted = steps.map((s) => ({ ...s, writes: s.writes.length }));
  const override = V.view({ steps: counted, state: 'STEP', step_index: 1, step_started_at: 2000, step_written: false }, { now: 2000 });
  assert.equal(override.node, 'OVERRIDE');
  const baseline = V.view({ steps: counted, state: 'BASELINE', step_index: 0, step_started_at: 2000, step_written: false }, { now: 2000 });
  assert.notEqual(baseline.node, 'OVERRIDE');
});
