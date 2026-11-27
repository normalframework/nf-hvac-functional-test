import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, next } = require('../hooks/lib/machine');

const steps = [
  { step_id: 'ahu.baseline', hold_ms: 0, writes: [] },
  { step_id: 'ahu.recirc', hold_ms: 1000, writes: [{ role: 'cooling_valve_position_command', value: 0 }], preconditions: [] },
  { step_id: 'ahu.economizer', hold_ms: 0, writes: [{ role: 'outdoor_air_intake_damper_position_command', value: 100 }], preconditions: ['econ_window'] },
  { step_id: 'recovery', hold_ms: 0, writes: [] },
];

test('a vav step with boxes writes even without a fleet default', () => {
  const vavSteps = [{
    step_id: 'vav.max_cool',
    hold_ms: 1000,
    writes: [],
    boxes: [{ equipment_id: 'vav_01', strategy: 'airflow_setpoint' }],
  }];
  let state = next(createState(), { type: 'START', now: 0, runId: 'run_vav', steps: vavSteps }).state;
  state = next(state, { type: 'PRECHECK_OK', now: 0 }).state;
  assert.equal(state.stepWritten, false);
  const wrote = next(state, { type: 'TICK', now: 0 });
  assert.equal(wrote.effects.some((effect) => effect.type === 'write'), true);
});

test('the machine releases on abort, timeout, comm loss, and a failed release', () => {
  let state = createState();
  assert.deepEqual(next(state, { type: 'ABORT' }).effects, []);
  assert.deepEqual(next(state, { type: 'NOPE' }).effects, []);
  state = next(state, { type: 'START', now: 0, runId: 'run_a', steps }).state;
  assert.equal(state.phase, 'PRECHECK');
  assert.deepEqual(next(state, { type: 'START', now: 1, runId: 'other', steps }).effects, []);
  state = next(state, { type: 'PRECHECK_OK', now: 0 }).state;
  assert.equal(state.phase, 'BASELINE');
  state = next(state, { type: 'TICK', now: 0 }).state;
  assert.equal(state.phase, 'STEP');
  const aborted = next(state, { type: 'ABORT', reason: 'abort' });
  assert.equal(aborted.state.phase, 'RELEASING');
  assert.equal(aborted.effects[0].type, 'release');
  const done = next(aborted.state, { type: 'RELEASE_OK' });
  assert.equal(done.state.phase, 'ABORTED');
  const stuck = next(aborted.state, { type: 'RELEASE_FAILED' });
  assert.equal(stuck.state.needsAttention, true);
  const again = next(stuck.state, { type: 'RETRY_RELEASE' });
  assert.equal(again.state.phase, 'RELEASING');
  const acked = next(stuck.state, { type: 'ACKNOWLEDGE' });
  assert.equal(acked.state.phase, 'IDLE');
  assert.equal(next(createState(), { type: 'ACKNOWLEDGE' }).state.phase, 'IDLE');
  assert.deepEqual(next(createState(), { type: 'RETRY_RELEASE' }).effects, []);

  let running = next(createState(), { type: 'START', now: 0, runId: 'run_b', steps }).state;
  running = next(running, { type: 'COMM_FAILURE' }).state;
  assert.equal(running.phase, 'PRECHECK');
  running.maxCommFailures = 1;
  running = next(running, { type: 'COMM_FAILURE' }).state;
  assert.equal(running.phase, 'RELEASING');
  assert.equal(running.reason, 'comm_loss');

  let timed = next(createState({ maxTotalMs: 10 }), { type: 'START', now: 0, runId: 'run_c', steps }).state;
  timed = next(timed, { type: 'PRECHECK_OK', now: 0 }).state;
  timed = next(timed, { type: 'TICK', now: 11 }).state;
  assert.equal(timed.reason, 'timeout');
});

test('economizer skip and a tick gap do not leave the run active', () => {
  let state = next(createState({ maxTickGapMs: 5000 }), { type: 'START', now: 10, runId: 'run_d', steps }).state;
  state = next(state, { type: 'PRECHECK_OK', now: 10 }).state;
  state = next(state, { type: 'TICK', now: 10 }).state;
  const written = next(state, { type: 'STEP_WRITTEN' });
  assert.equal(written.effects[0].type, 'sample');
  state = written.state;
  state = next(state, { type: 'TICK', now: 2000 }).state;
  assert.equal(state.steps[state.stepIndex].step_id, 'ahu.economizer');
  const checked = next(state, { type: 'ECON_OK', now: 2000 });
  assert.equal(checked.effects.some((effect) => effect.type === 'write'), true);
  const skipped = next(state, { type: 'ECON_SKIP', now: 2000 });
  assert.equal(skipped.state.steps[skipped.state.stepIndex].step_id, 'recovery');
  const gapped = next({ ...skipped.state, maxTickGapMs: 5, lastTick: 2000 }, { type: 'TICK', now: 3000 });
  assert.equal(gapped.state.reason, 'tick_gap');
  let released = next(skipped.state, { type: 'RELEASE_OK' });
  assert.equal(released.state.phase, 'RECOVERY');
  assert.equal(released.state.recovered, true);
  released = next(released.state, { type: 'TICK', now: 2000 });
  assert.equal(released.state.phase, 'RELEASING');
  released = next(released.state, { type: 'RELEASE_OK' });
  assert.equal(released.state.phase, 'COMPLETE');
  const failed = next(createState(), { type: 'START', now: 0, runId: 'run_e', steps: [] }).state;
  assert.equal(next(failed, { type: 'PRECHECK_FAILED', reason: 'fan_off' }).state.phase, 'FAILED');
});

test('every abnormal event from every active phase goes through RELEASING', () => {
  const { createState, next } = require('../hooks/lib/machine');
  const steps = [
    { step_id: 'ahu.baseline', writes: [], hold_ms: 1000 },
    { step_id: 'ahu.recirc', writes: [{ role: 'cooling_valve_position_command', value: 0 }], hold_ms: 1000 },
    { step_id: 'recovery', writes: [], hold_ms: 1000 },
  ];
  const phases = { PRECHECK: -1, BASELINE: 0, STEP: 1, RECOVERY: 2 };
  const events = ['ABORT', 'INTERLOCK', 'TIMEOUT', 'COMM_LOSS', 'TICK_GAP', 'WRITE_FAILED', 'EXCEPTION'];
  for (const [phase, stepIndex] of Object.entries(phases)) {
    for (const type of events) {
      const state = { ...createState(), phase, stepIndex, steps, runId: 'r', runStartedAt: 0, lastTick: 0 };
      const out = next(state, { type, now: 1 });
      assert.equal(out.state.phase, 'RELEASING', `${phase} ${type}`);
      assert.deepEqual(out.effects, [{ type: 'release' }], `${phase} ${type}`);
      // A run only ends once release is confirmed; a failed release is sticky.
      const done = next(out.state, { type: 'RELEASE_OK', now: 2 });
      assert.ok(['ABORTED', 'FAILED', 'COMPLETE', 'RECOVERY'].includes(done.state.phase), `${phase} ${type} -> ${done.state.phase}`);
      const stuck = next(out.state, { type: 'RELEASE_FAILED', now: 2 });
      assert.equal(stuck.state.phase, 'NEEDS_ATTENTION');
      assert.equal(next(stuck.state, { type: 'START', now: 3, runId: 'again', steps }).state.phase, 'NEEDS_ATTENTION');
    }
  }
});
