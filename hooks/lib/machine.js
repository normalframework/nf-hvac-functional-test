'use strict';

const TERMINAL = new Set(['COMPLETE', 'ABORTED', 'FAILED']);
const ACTIVE = new Set(['PRECHECK', 'BASELINE', 'STEP', 'RECOVERY', 'RELEASING']);

function createState(extra = {}) {
  return {
    phase: 'IDLE',
    needsAttention: false,
    runId: '',
    steps: /** @type {any[]} */ ([]),
    stepIndex: -1,
    stepStartedAt: 0,
    runStartedAt: 0,
    lastTick: 0,
    reason: '',
    stepWritten: false,
    recovered: false,
    econChecked: false,
    commFailures: 0,
    maxCommFailures: 3,
    maxTotalMs: 150 * 60 * 1000,
    maxTickGapMs: 60 * 1000,
    ...extra,
  };
}

/**
 * @param {any} state
 */
function clone(state) {
  return { ...state, steps: state.steps.slice() };
}

/**
 * @param {any} state
 * @param {string} reason
 */
function beginRelease(state, reason) {
  if (state.phase === 'IDLE' || state.phase === 'NEEDS_ATTENTION' || TERMINAL.has(state.phase)) {
    return { state, effects: [] };
  }
  return {
    state: { ...clone(state), phase: 'RELEASING', reason },
    effects: [{ type: 'release' }],
  };
}

/**
 * A VAV step with capable boxes still has work when no fleet-wide default is configured.
 * @param {any} step
 */
function stepNeedsWrite(step) {
  if ((step.writes || []).length > 0) return true;
  if (step.step_id !== 'vav.max_cool') return false;
  return (step.boxes || []).some((box) => box && box.strategy);
}

/**
 * @param {any} state
 * @param {number} now
 * @param {number} index
 */
function enter(state, now, index) {
  if (index >= state.steps.length) return beginRelease({ ...clone(state), stepIndex: index }, 'complete');
  const step = state.steps[index];
  if (step.step_id === 'recovery' && !state.recovered) {
    return beginRelease({ ...clone(state), stepIndex: index }, 'complete');
  }
  let phase = 'STEP';
  if (step.step_id === 'ahu.baseline') phase = 'BASELINE';
  if (step.step_id === 'recovery') phase = 'RECOVERY';
  return {
    state: {
      ...clone(state),
      phase,
      stepIndex: index,
      stepStartedAt: now,
      stepWritten: !stepNeedsWrite(step),
      econChecked: false,
    },
    effects: [{ type: 'enter_step', step, index }, { type: 'sample' }],
  };
}

/**
 * @param {any} state
 * @param {number} now
 */
function advance(state, now) {
  return enter(state, now, state.stepIndex + 1);
}

/**
 * @param {any} state
 * @param {any} event
 */
function onTick(state, event) {
  const gap = state.lastTick > 0 && event.now - state.lastTick > state.maxTickGapMs;
  const stamped = { ...clone(state), lastTick: event.now };
  if (gap && ACTIVE.has(state.phase)) return beginRelease(stamped, 'tick_gap');
  if (state.runId && event.now - state.runStartedAt > state.maxTotalMs && ACTIVE.has(state.phase)) {
    return beginRelease(stamped, 'timeout');
  }
  if (state.phase === 'PRECHECK') return { state: stamped, effects: [{ type: 'precheck' }] };
  if (state.phase === 'RELEASING') return { state: stamped, effects: [{ type: 'release' }] };
  if (!ACTIVE.has(state.phase)) return { state: stamped, effects: [] };
  const step = state.steps[state.stepIndex];
  if (!step) return beginRelease(stamped, 'complete');
  if (step.preconditions && step.preconditions.includes('econ_window') && !state.econChecked) {
    return { state: stamped, effects: [{ type: 'econ_check', step }] };
  }
  if (!state.stepWritten && stepNeedsWrite(step)) return { state: stamped, effects: [{ type: 'write', step }] };
  if (event.now - state.stepStartedAt >= step.hold_ms) return advance(stamped, event.now);
  return { state: stamped, effects: [{ type: 'sample' }] };
}

/**
 * @param {any} state
 * @param {any} event
 */
function next(state, event) {
  if (event.type === 'START') {
    if (state.needsAttention || ACTIVE.has(state.phase)) return { state, effects: [] };
    return {
      state: {
        ...clone(state),
        phase: 'PRECHECK',
        needsAttention: false,
        runId: event.runId,
        steps: event.steps || [],
        stepIndex: -1,
        runStartedAt: event.now,
        lastTick: event.now,
        stepStartedAt: event.now,
        reason: '',
        stepWritten: false,
        econChecked: false,
        commFailures: 0,
      },
      effects: [{ type: 'precheck' }],
    };
  }
  if (event.type === 'ACKNOWLEDGE') {
    if (!state.needsAttention) return { state, effects: [] };
    return {
      state: { ...clone(state), needsAttention: false, phase: 'IDLE', reason: 'acknowledged' },
      effects: [],
    };
  }
  if (event.type === 'RETRY_RELEASE') {
    if (state.phase !== 'NEEDS_ATTENTION') return { state, effects: [] };
    return { state: { ...clone(state), phase: 'RELEASING' }, effects: [{ type: 'release' }] };
  }
  if (event.type === 'COMM_FAILURE') {
    const commFailures = state.commFailures + 1;
    const stamped = { ...clone(state), commFailures };
    if (commFailures >= state.maxCommFailures && ACTIVE.has(state.phase)) return beginRelease(stamped, 'comm_loss');
    return { state: stamped, effects: [] };
  }
  if (event.type === 'ABORT' || event.type === 'INTERLOCK' || event.type === 'TIMEOUT' || event.type === 'COMM_LOSS' || event.type === 'TICK_GAP' || event.type === 'WRITE_FAILED' || event.type === 'EXCEPTION') {
    return beginRelease(state, event.reason || event.type.toLowerCase());
  }
  if (event.type === 'PRECHECK_OK') return enter(state, event.now, 0);
  if (event.type === 'PRECHECK_FAILED') {
    return { state: { ...clone(state), phase: 'FAILED', reason: event.reason || 'precheck' }, effects: [{ type: 'finish' }] };
  }
  if (event.type === 'RELEASE_OK') {
    if (state.reason === 'complete' && !state.recovered) {
      const index = state.steps.findIndex((step) => step.step_id === 'recovery');
      if (index >= 0) {
        return {
          state: {
            ...clone(state),
            phase: 'RECOVERY',
            stepIndex: index,
            stepStartedAt: state.lastTick,
            stepWritten: true,
            recovered: true,
          },
          effects: [{ type: 'enter_step', step: state.steps[index], index }, { type: 'sample' }],
        };
      }
    }
    let phase = 'FAILED';
    if (state.reason === 'complete') phase = 'COMPLETE';
    if (state.reason === 'abort') phase = 'ABORTED';
    return { state: { ...clone(state), phase }, effects: [{ type: 'finish' }] };
  }
  if (event.type === 'RELEASE_FAILED') {
    return {
      state: { ...clone(state), phase: 'NEEDS_ATTENTION', needsAttention: true },
      effects: [{ type: 'attention', value: 1 }],
    };
  }
  if (event.type === 'STEP_WRITTEN') {
    return { state: { ...clone(state), stepWritten: true }, effects: [{ type: 'sample' }] };
  }
  if (event.type === 'ECON_OK') return onTick({ ...clone(state), econChecked: true }, { type: 'TICK', now: event.now });
  if (event.type === 'ECON_SKIP') return advance({ ...clone(state), econChecked: true }, event.now);
  if (event.type === 'TICK') return onTick(state, event);
  return { state, effects: [] };
}

module.exports = { createState, next };
