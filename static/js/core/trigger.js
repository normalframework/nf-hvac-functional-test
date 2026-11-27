// Scheduled-trigger policy. Pure: the trigger hook and the page both use it.
// Modes: disabled (default), dry_run (scheduled rehearsal, no writes), armed (scheduled live run).
// Arming needs confirm === true and the typed phrase ARM. Changing the rule or windows disarms.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rrule.js'), require('./timetable.js'));
  else root.NfftTrigger = factory(root.NfftRrule, root.NfftTimetable);
})(globalThis, function (R, T) {
  'use strict';

  const MODES = ['disabled', 'dry_run', 'armed'];
  const ARM_PHRASE = 'ARM';
  const TOLERANCE_MS = 10 * 60 * 1000;
  const HISTORY_MAX = 50;

  function defaults() {
    return {
      version: 1,
      mode: 'disabled',
      rule: R.defaultRule(),
      windows: T.normalizeWindows([]),
      blackout: { schedule_uuid: '', block_when_occupied: true, block_on_special_event: true },
      armed: null,
      last_occurrence: null,
      history: [],
    };
  }

  /**
   * Fill and clean a stored or posted trigger document. Anything unusable falls back to the safe default.
   * @param {any} input
   */
  function normalize(input) {
    const base = defaults();
    const raw = input && typeof input === 'object' ? input : {};
    const checked = R.normalizeRule(raw.rule || base.rule);
    const rule = checked.ok ? checked.rule : base.rule;
    let mode = MODES.includes(raw.mode) ? raw.mode : 'disabled';
    const armed = raw.armed && typeof raw.armed === 'object' && typeof raw.armed.at === 'number'
      ? { at: raw.armed.at, by: typeof raw.armed.by === 'string' ? raw.armed.by : '' }
      : null;
    if (mode === 'armed' && !armed) mode = 'dry_run';
    if (!checked.ok && mode === 'armed') mode = 'dry_run';
    const blackoutRaw = raw.blackout && typeof raw.blackout === 'object' ? raw.blackout : {};
    return {
      version: 1,
      mode,
      rule,
      windows: T.normalizeWindows(raw.windows),
      blackout: {
        schedule_uuid: typeof blackoutRaw.schedule_uuid === 'string' ? blackoutRaw.schedule_uuid : '',
        block_when_occupied: blackoutRaw.block_when_occupied !== false,
        block_on_special_event: blackoutRaw.block_on_special_event !== false,
      },
      armed: mode === 'armed' ? armed : null,
      last_occurrence: typeof raw.last_occurrence === 'number' ? raw.last_occurrence : null,
      history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_MAX) : [],
    };
  }

  /**
   * @param {any} doc
   * @param {{ op: string, rule?: any, windows?: any, blackout?: any, confirm?: unknown, phrase?: unknown, now: number, by?: string }} change
   * @returns {{ ok: true, doc: any, note: string | null } | { ok: false, code: string, errors?: string[] }}
   */
  function apply(doc, change) {
    const current = normalize(doc);
    if (change.op === 'save') {
      /** @type {any} */
      const nextDoc = { ...current };
      if (change.rule !== undefined) {
        const checked = R.normalizeRule(change.rule);
        if (!checked.ok) return { ok: false, code: 'invalid_rule', errors: checked.errors };
        nextDoc.rule = checked.rule;
      }
      if (change.windows !== undefined) nextDoc.windows = T.normalizeWindows(change.windows);
      if (change.blackout !== undefined) nextDoc.blackout = normalize({ blackout: change.blackout }).blackout;
      const changed = JSON.stringify([nextDoc.rule, nextDoc.windows, nextDoc.blackout])
        !== JSON.stringify([current.rule, current.windows, current.blackout]);
      let note = null;
      if (changed && current.mode === 'armed') {
        nextDoc.mode = 'dry_run';
        nextDoc.armed = null;
        note = 'disarmed_on_change';
      }
      if (changed) nextDoc.last_occurrence = null;
      return { ok: true, doc: normalize(nextDoc), note };
    }
    if (change.op === 'disable') return { ok: true, doc: normalize({ ...current, mode: 'disabled', armed: null }), note: null };
    if (change.op === 'dry_run') return { ok: true, doc: normalize({ ...current, mode: 'dry_run', armed: null }), note: null };
    if (change.op === 'arm') {
      if (change.confirm !== true || change.phrase !== ARM_PHRASE) return { ok: false, code: 'confirm_required' };
      return {
        ok: true,
        doc: normalize({ ...current, mode: 'armed', armed: { at: change.now, by: change.by || '' } }),
        note: null,
      };
    }
    return { ok: false, code: 'unknown_op' };
  }

  /**
   * What the trigger hook does now.
   * @param {any} doc
   * @param {{ now: number, schedule?: any, scheduleError?: boolean, toleranceMs?: number }} ctx
   * @returns {{ action: 'none' | 'skip' | 'start', live: boolean, occurrence: number | null, reason: string }}
   */
  function decide(doc, ctx) {
    const current = normalize(doc);
    if (current.mode === 'disabled') return { action: 'none', live: false, occurrence: null, reason: 'disabled' };
    const occurrence = R.dueOccurrence(current.rule, ctx.now, ctx.toleranceMs || TOLERANCE_MS);
    if (occurrence === null) return { action: 'none', live: false, occurrence: null, reason: 'not_due' };
    if (current.last_occurrence === occurrence) return { action: 'none', live: false, occurrence, reason: 'already_handled' };
    const tz = current.rule.tz;
    if (!T.inWindow(current.windows, occurrence, tz)) return { action: 'skip', live: false, occurrence, reason: 'outside_window' };
    const gate = T.blackout({
      configured: Boolean(current.blackout.schedule_uuid),
      schedule: ctx.scheduleError ? null : (ctx.schedule || null),
      block_when_occupied: current.blackout.block_when_occupied,
      block_on_special_event: current.blackout.block_on_special_event,
    }, occurrence, tz);
    if (gate.blocked) return { action: 'skip', live: false, occurrence, reason: /** @type {string} */ (gate.reason) };
    const live = current.mode === 'armed';
    return { action: 'start', live, occurrence, reason: live ? 'armed' : 'dry_run' };
  }

  /**
   * Record a decision so the same occurrence is never handled twice.
   * @param {any} doc
   * @param {{ action: string, live: boolean, occurrence: number | null, reason: string }} decision
   * @param {number} now
   * @param {string} [runId]
   */
  function record(doc, decision, now, runId) {
    const current = normalize(doc);
    if (decision.action === 'none') return current;
    const entry = { at: now, occurrence: decision.occurrence, action: decision.action, live: decision.live, reason: decision.reason, run_id: runId || '' };
    return normalize({ ...current, last_occurrence: decision.occurrence, history: [...current.history, entry] });
  }

  /**
   * Preview for the page: the next runs, and for each one whether the window and the blackout allow it.
   * schedule undefined means the blackout was not checked here; the trigger hook checks it at run time.
   * @param {any} doc
   * @param {number} now
   * @param {any} [schedule] normalized NF schedule, or null when a configured one could not be read
   * @param {number} [count]
   */
  function preview(doc, now, schedule, count = 6) {
    const current = normalize(doc);
    const tz = current.rule.tz;
    const configured = Boolean(current.blackout.schedule_uuid);
    return R.nextRuns(current.rule, now, count).map((at) => {
      const window = T.inWindow(current.windows, at, tz);
      const gate = schedule === undefined
        ? { blocked: false, reason: null }
        : T.blackout({
          configured,
          schedule,
          block_when_occupied: current.blackout.block_when_occupied,
          block_on_special_event: current.blackout.block_on_special_event,
        }, at, tz);
      const reason = !window ? 'outside_window' : gate.blocked ? gate.reason : null;
      return {
        at,
        local: R.formatLocal(at, tz),
        utc: R.formatUtc(at),
        runs: reason === null,
        reason,
        blackout: !configured ? 'none' : schedule === undefined ? 'checked_at_run' : 'checked',
      };
    });
  }

  return { MODES, ARM_PHRASE, TOLERANCE_MS, defaults, normalize, apply, decide, record, preview };
});
