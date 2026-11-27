'use strict';

const Rrule = require('../../static/rrule.js');
const Timetable = require('../../static/timetable.js');
const Trigger = require('../../static/trigger.js');
const { NfClient } = require('./nf/client');
const { readState, writeState } = require('./persist');
const { readTrigger, writeTrigger } = require('./trigger_store');
const { nfBaseUrl } = require('./runtime');
const { ulid } = require('./ulid');

const ACTIVE = new Set(['PRECHECK', 'BASELINE', 'STEP', 'RECOVERY', 'RELEASING', 'NEEDS_ATTENTION']);

/**
 * One trigger-hook invocation. NF calls the hook on a short RRULE cadence; the stored rule, evaluated in
 * the site timezone, decides whether a run is due. A due run is queued as pending_start for the tick hook,
 * the same path an operator start takes. Dry-run unless the trigger is armed.
 * @param {any} session
 * @param {{ now: number, sdk?: any }} ctx
 */
async function runTrigger(session, ctx) {
  const now = ctx.now;
  const doc = readTrigger(session.root);
  if (doc.mode === 'disabled') return { action: 'none', reason: 'disabled', mode: doc.mode };
  if (Rrule.dueOccurrence(doc.rule, now, Trigger.TOLERANCE_MS) === null) {
    return { action: 'none', reason: 'not_due', mode: doc.mode };
  }
  /** @type {any} */
  let schedule;
  let scheduleError = false;
  if (doc.blackout.schedule_uuid) {
    try {
      const client = session.client || new NfClient({ baseUrl: nfBaseUrl(ctx.sdk || {}), sleep: async () => {} });
      schedule = Timetable.normalizeSchedule(await client.getSchedule(doc.blackout.schedule_uuid));
      if (!schedule) scheduleError = true;
    } catch {
      scheduleError = true;
    }
  }
  let decision = Trigger.decide(doc, { now, schedule, scheduleError });
  if (decision.action === 'none') return { ...decision, mode: doc.mode };
  const saved = readState(session.root);
  const phase = saved.state && saved.state.phase;
  if (decision.action === 'start' && (ACTIVE.has(phase) || saved.pending_start)) {
    decision = { ...decision, action: 'skip', live: false, reason: 'run_active' };
  }
  const runId = decision.action === 'start' ? ulid() : '';
  // Record first: a crash after this line misses one run, it never starts two.
  writeTrigger(session.root, Trigger.record(doc, decision, now, runId));
  if (decision.action === 'start') {
    writeState(session.root, {
      ...saved,
      pending_start: {
        run_id: runId,
        live: decision.live,
        confirm_live: decision.live,
        dry_run: !decision.live,
        source: 'schedule',
      },
    });
  }
  return { ...decision, run_id: runId, mode: doc.mode };
}

module.exports = { runTrigger };
