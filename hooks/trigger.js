'use strict';

const { createSession } = require('./lib/admin');
const { ensureRuntime } = require('./lib/runtime');
const { runTrigger } = require('./lib/trigger_run');
const { readTrigger } = require('./lib/trigger_store');
const Rrule = require('../static/rrule.js');

/** @type {any} */
let session = createSession();

/**
 * Scheduled trigger. Disabled until an operator enables it on the page; dry-run unless armed.
 * @param {any} ctx
 */
async function onTrigger(ctx) {
  const sdk = ctx && ctx.sdk ? ctx.sdk : (ctx || {});
  if (ctx && Array.isArray(ctx.globalVariables)) sdk.globalVariables = ctx.globalVariables;
  ensureRuntime(session, sdk);
  const enabled = sdk.options ? sdk.options.enabled : true;
  const now = session.clock ? session.clock.now() : Date.now();
  const result = enabled === false ? { action: 'none', reason: 'app_disabled' } : await runTrigger(session, { now, sdk });
  const doc = readTrigger(session.root);
  const [nextRun] = doc.mode === 'disabled' ? [] : Rrule.nextRuns(doc.rule, now + 1, 1);
  /** @type {Record<string, any>} */
  const values = { ftest_trigger_mode: doc.mode, ftest_trigger_next: nextRun ? new Date(nextRun).toISOString() : '' };
  for (const variable of Array.isArray(sdk.globalVariables) ? sdk.globalVariables : []) {
    if (variable && Object.prototype.hasOwnProperty.call(values, variable.label)) variable.value = values[variable.label];
  }
  return { ...result, ...values };
}

onTrigger.useSession = (/** @type {any} */ next) => {
  session = next;
};

module.exports = onTrigger;
