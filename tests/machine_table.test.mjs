import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, next } = require('../hooks/lib/machine');

const EVENTS = [
  { type: 'START', now: 0, runId: 'run_table', steps: [] },
  { type: 'TICK', now: 1000 },
  { type: 'ABORT', now: 1000, reason: 'abort' },
  { type: 'INTERLOCK', now: 1000, reason: 'interlock:discharge_air_low' },
  { type: 'PRECHECK_OK', now: 1000 },
  { type: 'PRECHECK_FAILED', now: 1000, reason: 'precheck' },
  { type: 'RELEASE_OK' },
  { type: 'RELEASE_FAILED' },
  { type: 'STEP_WRITTEN' },
  { type: 'COMM_FAILURE' },
  { type: 'ACKNOWLEDGE' },
  { type: 'RETRY_RELEASE' },
];

const STEPS = [
  { step_id: 'ahu.baseline', hold_ms: 0, writes: [] },
  { step_id: 'ahu.recirc', hold_ms: 60000, writes: [{ role: 'cooling_valve_position_command', value: 0 }] },
  { step_id: 'vav.max_cool', hold_ms: 60000, writes: [], boxes: [{ equipment_id: 'vav_01', strategy: 'airflow_setpoint' }] },
  { step_id: 'recovery', hold_ms: 0, writes: [] },
];

function reach() {
  const idle = createState();
  const precheck = next(idle, { type: 'START', now: 0, runId: 'run_table', steps: STEPS }).state;
  const baseline = next(precheck, { type: 'PRECHECK_OK', now: 0 }).state;
  const step = next(baseline, { type: 'TICK', now: 0 }).state;
  const releasing = next(step, { type: 'ABORT', now: 1000, reason: 'abort' }).state;
  const attention = next(releasing, { type: 'RELEASE_FAILED' }).state;
  const aborted = next(releasing, { type: 'RELEASE_OK' }).state;
  const failed = next(precheck, { type: 'PRECHECK_FAILED', now: 0, reason: 'precheck' }).state;
  let towardEnd = next(createState(), { type: 'START', now: 0, runId: 'run_done', steps: [{ step_id: 'recovery', hold_ms: 0, writes: [] }] }).state;
  towardEnd = next(towardEnd, { type: 'PRECHECK_OK', now: 0 }).state;
  towardEnd = next(towardEnd, { type: 'RELEASE_OK' }).state;
  const complete = next(towardEnd, { type: 'RELEASE_OK' }).state;
  return { idle, precheck, baseline, step, releasing, attention, aborted, failed, complete };
}

test('every state and event has a generated transition', () => {
  const states = reach();
  assert.equal(states.step.phase, 'STEP');
  assert.equal(states.step.steps[states.step.stepIndex].step_id, 'ahu.recirc');
  const rows = [];
  for (const [name, state] of Object.entries(states)) {
    for (const event of EVENTS) {
      const result = next(state, event);
      rows.push(`${name} ${state.phase} + ${event.type} -> ${result.state.phase}`);
      assert.ok(result.state.phase);
    }
  }
  const active = ['precheck', 'baseline', 'step'];
  for (const name of active) {
    assert.equal(next(states[name], { type: 'ABORT', now: 1, reason: 'abort' }).state.phase, 'RELEASING');
  }
  assert.equal(next(states.idle, { type: 'ABORT', now: 1 }).state.phase, 'IDLE');
  assert.equal(next(states.complete, { type: 'ABORT', now: 1 }).state.phase, 'COMPLETE');
  assert.equal(rows.length, Object.keys(states).length * EVENTS.length);
  const fingerprint = rows.filter((row) => row.includes('ABORT') || row.includes('RELEASE_OK') || row.includes('vav')).join('\n');
  assert.match(fingerprint, /step STEP \+ ABORT -> RELEASING/);
  assert.match(fingerprint, /releasing RELEASING \+ RELEASE_OK -> ABORTED/);
  assert.match(fingerprint, /complete COMPLETE \+ ABORT -> COMPLETE/);
});
