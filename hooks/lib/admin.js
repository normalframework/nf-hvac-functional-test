'use strict';

const path = require('node:path');
const { validateSiteConfig } = require('./config');
const { readState, writeState } = require('./persist');
const { ulid } = require('./ulid');
const Rrule = require('../../static/rrule.js');
const Trigger = require('../../static/trigger.js');
const { readTrigger, writeTrigger } = require('./trigger_store');

const ACTIVE = new Set(['PRECHECK', 'BASELINE', 'STEP', 'RECOVERY', 'RELEASING', 'NEEDS_ATTENTION']);

const GLOBALS = [
  'ftest_state',
  'ftest_step_index',
  'ftest_run_seq',
  'ftest_overrides_active',
  'ftest_needs_attention',
];

function createSession() {
  return {
    runner: /** @type {any} */ (null),
    factory: /** @type {any} */ (null),
    client: /** @type {any} */ (null),
    configText: '',
    last: /** @type {any} */ (null),
  };
}

/**
 * Run status for the page. The admin and tick hooks are separate instances, so without a runner in this
 * process the shared state file is the source.
 * @param {any} session
 */
function status(session) {
  const runner = session.runner;
  const saved = !runner && session.root ? readState(session.root) : null;
  const state = runner
    ? runner.state
    : (saved && saved.state) || { phase: 'IDLE', stepIndex: -1, runId: '', needsAttention: false };
  const overrides = runner && runner.manifest ? runner.manifest.overrides.length : 0;
  let dryRun = true;
  if (runner) dryRun = runner.manifest.dry_run !== false;
  else if (saved && saved.dry_run === false) dryRun = false;
  const steps = Array.isArray(state.steps) ? state.steps : [];
  return {
    ok: true,
    state: state.phase,
    step_index: Number.isInteger(state.stepIndex) ? state.stepIndex : -1,
    run_id: state.runId || '',
    overrides,
    needs_attention: Boolean(state.needsAttention || (runner && runner.attention)),
    dry_run: dryRun,
    capability: runner && runner.vavReport ? runner.vavReport : [],
    reason: state.reason || '',
    run_started_at: state.runStartedAt || 0,
    step_started_at: state.stepStartedAt || 0,
    step_written: state.stepWritten !== false,
    max_total_ms: state.maxTotalMs || 0,
    pending_start: Boolean(saved && saved.pending_start),
    system_id: (runner && runner.system_id) || (saved && saved.pending_start && saved.pending_start.system_id) || null,
    systems: (saved && saved.systems) || (runner && runner.system_id ? [{ id: runner.system_id, active: true, state: state.phase }] : []),
    steps: steps.map((/** @type {any} */ step) => ({
      step_id: step.step_id,
      hold_ms: step.hold_ms || 0,
      settle_ms: step.settle_ms || 0,
      writes: (step.writes || []).length,
    })),
  };
}

/**
 * @param {any} session
 */
function nowOf(session) {
  return session.clock ? session.clock.now() : Date.now();
}

/**
 * @param {any} session
 */
function loadTrigger(session) {
  if (session.root) return readTrigger(session.root);
  return Trigger.normalize(session.trigger);
}

/**
 * @param {any} session
 * @param {any} doc
 */
function saveTrigger(session, doc) {
  if (session.root) writeTrigger(session.root, doc);
  else session.trigger = Trigger.normalize(doc);
}

/**
 * Trigger document plus what the page shows next to it. Blackout is checked by the trigger hook at run time.
 * @param {any} session
 * @param {any} doc
 * @param {string | null} note
 */
function triggerView(session, doc, note) {
  const now = nowOf(session);
  return {
    ok: true,
    note,
    trigger: { ...doc, history: doc.history.slice(-20) },
    describe: Rrule.describe(doc.rule),
    rrule: Rrule.toRrule(doc.rule),
    next_runs: Trigger.preview(doc, now, undefined, 6),
    arm_phrase: Trigger.ARM_PHRASE,
    writes: 0,
  };
}

/**
 * Plan preview from the site configuration: what each step would write, with no NF calls and no writes.
 * Query bindings resolve when a run starts and are shown as unbound here.
 * @param {any} session
 */
function planPreview(session) {
  const { parseSiteConfig, modelFromBindings } = require('./runtime');
  const { buildPlan } = require('./plan');
  const { runnableSteps } = require('./runner');
  let parsed;
  try {
    parsed = parseSiteConfig({ options: session.options || {} });
  } catch {
    return { ok: false, code: 'site_config', writes: 0 };
  }
  if (!parsed) return { ok: false, code: 'site_config', writes: 0 };
  const validated = validateSiteConfig(parsed);
  if (!validated.ok) return { ok: false, code: 'site_config', errors: validated.errors || [], writes: 0 };
  const config = validated.config;
  const plan = buildPlan(modelFromBindings(config), config);
  const { getRole } = require('./roles');
  /** @type {Record<string, string>} */
  const types = {};
  for (const item of config.equipment || []) types[item.id] = item.type;
  /** @type {Record<string, string | null>} */
  const units = {};
  for (const p of plan.sample_points) {
    const role = getRole(p.role);
    units[p.role] = role && role.unit ? role.unit : null;
  }
  return {
    ok: true,
    writes: 0,
    dry_run: config.dry_run !== false,
    priority: config.write.bacnet_priority,
    lease_s: config.write.command_lease_s,
    equipment_types: types,
    units,
    plan: {
      ready: plan.ready,
      reason: plan.reason,
      equipment_id: plan.equipment_id,
      steps: plan.steps.map((/** @type {any} */ step) => ({ step_id: step.step_id, status: step.status, skip_reason: step.skip_reason })),
      sample_points: plan.sample_points.map((/** @type {any} */ p) => ({ equipment_id: p.equipment_id, role: p.role })),
      interlocks: plan.interlocks,
    },
    steps: plan.ready ? runnableSteps(plan, config) : [],
  };
}

/**
 * @param {any} session
 * @param {string} action
 * @param {any} args
 */
async function adminAction(session, action, args = {}) {
  if (action === 'config' && args.op === 'validate') {
    let parsed = args.config;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed || '{}');
    const result = validateSiteConfig(parsed || {});
    return { ok: result.ok, errors: result.errors || [] };
  }
  if (action === 'config' && args.op === 'discover') {
    if (!session.client) return { ok: false, code: 'no_client' };
    const query = args.query && typeof args.query === 'object' ? args.query : {};
    const bounded = boundedDiscover(query);
    if (!bounded) return { ok: false, code: 'query_unbounded', writes: 0 };
    const reply = await session.client.queryPoints(bounded);
    return { ok: true, count: (reply.points || []).length, writes: 0 };
  }
  if (action === 'start') {
    if (args.live === true && args.confirm_live !== true) return { ok: false, code: 'confirm_live', writes: 0 };
    const runId = args.run_id || ulid();
    if (session.root) {
      const saved = readState(session.root);
      const phase = saved.state && saved.state.phase;
      if (ACTIVE.has(phase) || saved.pending_start) return { ok: false, code: 'run_active' };
      saved.pending_start = {
        run_id: runId,
        confirm_live: args.confirm_live === true,
        live: args.live === true,
        test_id: args.test_id || null,
        system_id: args.system_id || null,
        hold_minutes: args.hold_minutes || null,
      };
      writeState(session.root, saved);
      session.last = { ok: true, state: 'IDLE', pending: true, writes: 0 };
      return session.last;
    }
    if (session.runner && runStillHeld(session.runner)) return { ok: false, code: 'run_active' };
    if (!session.factory) return { ok: false, code: 'no_runner' };
    const runner = await session.factory(args);
    if (!runner) return { ok: false, code: 'confirm_live', writes: 0 };
    session.runner = runner;
    attachRunFiles(session, runner);
    await runner.start(runId);
    session.last = status(session);
    return session.last;
  }
  if (action === 'abort') {
    if (session.runner) await session.runner.abort();
    session.last = status(session);
    return session.last;
  }
  if (action === 'status') return status(session);
  if (action === 'trigger') {
    const op = String(args.op || 'get');
    const current = loadTrigger(session);
    if (op === 'get') return triggerView(session, current, null);
    const changed = Trigger.apply(current, {
      op,
      rule: args.rule,
      windows: args.windows,
      blackout: args.blackout,
      confirm: args.confirm,
      phrase: args.phrase,
      by: typeof args.by === 'string' ? args.by : '',
      now: nowOf(session),
    });
    if (!changed.ok) return { ...changed, writes: 0 };
    saveTrigger(session, changed.doc);
    return triggerView(session, changed.doc, changed.note);
  }
  if (action === 'plan_preview') return planPreview(session);
  if (action === 'retry_release') {
    if (session.runner) await session.runner.retryRelease();
    session.last = status(session);
    return session.last;
  }
  if (action === 'acknowledge') {
    if (session.runner) {
      session.runner.attention = 0;
      await session.runner.acknowledge();
    }
    session.last = status(session);
    return session.last;
  }
  return { ok: false, code: 'unknown_action' };
}

/**
 * @param {any} sdk
 * @param {any} session
 */
async function tick(sdk, session) {
  const enabled = sdk.options ? sdk.options.enabled : true;
  if (enabled === false) return { skipped: true };
  if (session && session.root) await drive(session);
  const view = status(session || { runner: null });
  const values = {
    ftest_state: view.state,
    ftest_step_index: view.step_index,
    ftest_run_seq: view.run_id,
    ftest_overrides_active: view.overrides,
    ftest_needs_attention: view.needs_attention ? 1 : 0,
  };
  const variables = Array.isArray(sdk.globalVariables) ? sdk.globalVariables : [];
  for (const variable of variables) {
    if (variable && Object.prototype.hasOwnProperty.call(values, variable.label)) variable.value = values[variable.label];
  }
  for (const name of GLOBALS) {
    if (typeof sdk.setGlobal === 'function') sdk.setGlobal(name, values[name]);
  }
  return values;
}

/**
 * Best-effort release used by the tick hook on SIGTERM. Tests pass the registrar.
 * @param {{ onSignal?: (signal: string, fn: () => void) => void }} sdk
 * @param {() => void} release
 */
/**
 * Load the shared state file, resume or start, tick once, and write the file back.
 * @param {any} session
 */
async function drive(session) {
  const saved = readState(session.root);
  if (!session.runner && saved.pending_start && session.factory) {
    const runner = await session.factory(saved.pending_start);
    if (!runner) {
      writeState(session.root, { ...saved, pending_start: null, last_error: session.last_error || 'confirm_live' });
      return;
    }
    runner.paced = true;
    session.runner = runner;
    attachRunFiles(session, runner);
    await releaseForeign(runner, saved.pending_start.run_id);
    await runner.start(saved.pending_start.run_id || ulid());
  } else if (!session.runner && saved.state && ACTIVE.has(saved.state.phase) && session.factory) {
    const runner = await session.factory(saved);
    if (runner) {
      runner.paced = true;
      session.runner = runner;
      runner.state = { ...runner.state, ...saved.state };
      // A resumed runner has a fresh manifest; keep the dry-run flag the page shows truthful.
      if (runner.manifest && runner.config) runner.manifest.dry_run = runner.config.dry_run !== false;
      applyCursor(runner, saved);
      await releaseForeign(runner, saved.state.runId);
    }
  }
  if (session.runner && typeof session.runner.tick === 'function' && ACTIVE.has(session.runner.state.phase)) {
    await session.runner.tick();
  }
  writeState(session.root, {
    pending_start: null,
    state: session.runner ? session.runner.state : (saved.state || { phase: 'IDLE' }),
    cursor: cursorOf(session.runner),
    dry_run: session.runner ? session.runner.manifest.dry_run !== false : true,
    confirm_live: Boolean((saved.pending_start && saved.pending_start.confirm_live) || saved.confirm_live),
  });
}

/**
 * @param {any} runner
 */
function cursorOf(runner) {
  if (!runner) return { vav_index: 0, next_retry_at: 0, last_extend_at: null };
  return {
    vav_index: runner.vavIndex || 0,
    next_retry_at: runner.nextRetryAt || 0,
    last_extend_at: runner.lastExtendAt === null || runner.lastExtendAt === undefined ? null : runner.lastExtendAt,
  };
}

/**
 * @param {any} runner
 * @param {any} saved
 */
function applyCursor(runner, saved) {
  const cursor = saved && saved.cursor;
  if (!cursor) return;
  runner.vavIndex = cursor.vav_index || 0;
  runner.nextRetryAt = cursor.next_retry_at || 0;
  runner.lastExtendAt = cursor.last_extend_at === null || cursor.last_extend_at === undefined ? null : cursor.last_extend_at;
}

/**
 * Discover lists one equipment or one point. An empty query is refused.
 * @param {any} query
 */
function boundedDiscover(query) {
  if (typeof query.uuid === 'string' && query.uuid) return { uuid: query.uuid };
  if (typeof query.equip_ref !== 'string' || !query.equip_ref) return null;
  /** @type {Record<string, unknown>} */
  const body = { equip_ref: query.equip_ref };
  if (Array.isArray(query.markers)) body.markers = query.markers;
  if (typeof query.layer === 'string') body.layer = query.layer;
  return body;
}

/**
 * Release ledger rows that belong to an older run. The active run stays held.
 * @param {any} runner
 * @param {string} runId
 */
async function releaseForeign(runner, runId) {
  if (!runner.ledger || typeof runner.recover !== 'function') return;
  const foreign = runner.ledger.openOverrides().filter((entry) => entry.run_id !== runId);
  if (!foreign.length && !runner.ledger.openPeriods().length) return;
  if (typeof runner.recoverForeign === 'function') await runner.recoverForeign(runId);
}

/**
 * Shadow samples and the run manifest live under the install directory.
 * @param {any} session
 * @param {any} runner
 */
/**
 * A second start is refused while this process still holds a run or an override.
 * @param {any} runner
 */
function runStillHeld(runner) {
  const phase = runner.state && runner.state.phase;
  if (ACTIVE.has(phase) || phase === 'NEEDS_ATTENTION' || (runner.state && runner.state.needsAttention)) return true;
  if (!runner.ledger) return false;
  return runner.ledger.openOverrides().length > 0 || runner.ledger.openPeriods().length > 0;
}

function attachRunFiles(session, runner) {
  if (!session.root) return;
  runner.seqDir = path.join(session.root, 'local');
  runner.manifestDir = path.join(session.root, 'local', 'runs');
}

function bindRelease(sdk, release) {
  if (typeof sdk.onSignal !== 'function') return;
  sdk.onSignal('SIGTERM', () => {
    try {
      release();
    } catch {
      // shutdown must not throw
    }
  });
}

module.exports = {
  GLOBALS,
  createSession,
  adminAction,
  status,
  tick,
  bindRelease,
};
