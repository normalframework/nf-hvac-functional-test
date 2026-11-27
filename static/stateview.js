// Operator view of the run state machine (lib/machine.js). Pure: maps the engine phase and step clock
// to the page's states and countdowns. Engine phases stay the source of truth.
//   IDLE -> SCHEDULED -> PRECHECK -> OVERRIDE (step n) -> SETTLE -> CAPTURE -> RELEASE -> REPORT -> IDLE
// NEEDS_ATTENTION sits off the path: a release could not be verified and an operator must act.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NfftStateView = factory();
})(globalThis, function () {
  'use strict';

  const NODES = ['IDLE', 'SCHEDULED', 'PRECHECK', 'OVERRIDE', 'SETTLE', 'CAPTURE', 'RELEASE', 'REPORT'];
  const TERMINAL = { COMPLETE: 'pass', ABORTED: 'aborted', FAILED: 'fail' };
  const STEP_PHASES = new Set(['BASELINE', 'STEP']);

  /**
   * @param {number} ms
   */
  function formatCountdown(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0:00';
    const total = Math.ceil(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (d > 0) return `${d}d ${String(h).padStart(2, '0')}:${mmss}`;
    if (h > 0) return `${h}:${mmss}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * @param {any} step
   */
  function writesIn(step) {
    if (!step) return 0;
    if (typeof step.writes === 'number') return step.writes;
    const writes = Array.isArray(step.writes) ? step.writes.length : 0;
    const boxes = Array.isArray(step.boxes) ? step.boxes.filter((/** @type {any} */ b) => b && b.strategy).length : 0;
    return writes + boxes;
  }

  /**
   * @param {any} status admin status (see lib/admin.js status())
   * @param {{ now: number, nextRunAt?: number | null, triggerMode?: string }} ctx
   */
  function view(status, ctx) {
    const s = status || {};
    const now = ctx.now;
    const phase = s.state || 'IDLE';
    const steps = Array.isArray(s.steps) ? s.steps : [];
    const index = Number.isInteger(s.step_index) ? s.step_index : -1;
    const step = index >= 0 ? steps[index] : null;
    /** @type {{ id: string, label: string, remaining_ms: number, total_ms: number }[]} */
    const countdowns = [];
    const scheduled = ctx.triggerMode && ctx.triggerMode !== 'disabled' && typeof ctx.nextRunAt === 'number';
    if (scheduled) {
      const left = /** @type {number} */ (ctx.nextRunAt) - now;
      countdowns.push({ id: 'next_trigger', label: 'Next scheduled run', remaining_ms: Math.max(0, left), total_ms: 0 });
    }
    let node = 'IDLE';
    let detail = 'No run in progress';
    let outcome = null;
    let attention = false;
    if (phase === 'NEEDS_ATTENTION' || s.needs_attention) {
      node = 'NEEDS_ATTENTION';
      attention = true;
      detail = 'A release was not verified. Retry release or acknowledge after checking the equipment.';
    } else if (phase === 'IDLE') {
      node = scheduled ? 'SCHEDULED' : 'IDLE';
      detail = scheduled ? `Waiting for the next ${ctx.triggerMode === 'armed' ? 'live' : 'dry-run'} trigger` : 'Scheduled trigger is disabled';
    } else if (phase === 'PRECHECK') {
      node = 'PRECHECK';
      detail = 'Checking interlocks, data freshness, and command priority. Nothing is written yet.';
    } else if (STEP_PHASES.has(phase) && step) {
      const elapsed = Math.max(0, now - (typeof s.step_started_at === 'number' && s.step_started_at > 0 ? s.step_started_at : now));
      const hold = Number(step.hold_ms) || 0;
      const settle = Math.min(hold, Number(step.settle_ms) || 0);
      const writes = writesIn(step);
      if (writes > 0 && s.step_written === false) {
        node = 'OVERRIDE';
        detail = `Writing ${writes} override${writes === 1 ? '' : 's'} through the command service`;
      } else if (elapsed < settle) {
        node = 'SETTLE';
        detail = 'Equipment is settling. Analysts exclude this window.';
        countdowns.push({ id: 'settle', label: 'Settle', remaining_ms: settle - elapsed, total_ms: settle });
      } else {
        node = 'CAPTURE';
        detail = 'Capturing higher-rate samples for this step';
      }
      countdowns.push({ id: 'step', label: `Step ${index + 1} hold`, remaining_ms: Math.max(0, hold - elapsed), total_ms: hold });
    } else if (phase === 'RELEASING' || phase === 'RECOVERY') {
      node = 'RELEASE';
      if (phase === 'RECOVERY' && step) {
        const elapsed = Math.max(0, now - (typeof s.step_started_at === 'number' && s.step_started_at > 0 ? s.step_started_at : now));
        const hold = Number(step.hold_ms) || 0;
        detail = 'Overrides released. Watching the system recover.';
        countdowns.push({ id: 'recovery', label: 'Recovery window', remaining_ms: Math.max(0, hold - elapsed), total_ms: hold });
      } else {
        detail = 'Cancelling commands and verifying every priority slot is empty';
      }
    } else if (Object.prototype.hasOwnProperty.call(TERMINAL, phase)) {
      node = 'REPORT';
      outcome = /** @type {Record<string, string>} */ (TERMINAL)[phase];
      detail = `Run ${outcome === 'pass' ? 'completed' : outcome === 'fail' ? 'failed' : 'aborted'}${s.reason ? ` (${s.reason})` : ''}. Manifest written.`;
    }
    const active = ['PRECHECK', 'OVERRIDE', 'SETTLE', 'CAPTURE', 'RELEASE'].includes(node);
    if (active && s.run_started_at && s.max_total_ms) {
      const left = s.run_started_at + s.max_total_ms - now;
      countdowns.push({ id: 'run_limit', label: 'Run time limit', remaining_ms: Math.max(0, left), total_ms: s.max_total_ms });
    }
    const at = NODES.indexOf(node);
    const path = NODES.map((id, i) => ({
      id,
      status: attention ? (id === 'RELEASE' ? 'current' : i < NODES.indexOf('RELEASE') ? 'done' : 'todo')
        : i < at ? 'done' : i === at ? 'current' : 'todo',
    }));
    const label = node === 'OVERRIDE' || node === 'SETTLE' || node === 'CAPTURE'
      ? `${node === 'OVERRIDE' ? `OVERRIDE_STEP_${index + 1}` : node} · ${step ? step.step_id : ''}`
      : node;
    return {
      node,
      label,
      detail,
      outcome,
      attention,
      step: step ? { n: index + 1, total: steps.length, step_id: step.step_id } : null,
      countdowns,
      path,
    };
  }

  return { NODES, view, formatCountdown };
});
