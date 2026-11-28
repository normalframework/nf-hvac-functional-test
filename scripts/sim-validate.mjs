#!/usr/bin/env node
// Hook validation on the office simulator: runs the EXISTING functional-test sequences through the app's own admin
// and tick hooks on a LOCAL NF (localhost only), samples the sim every minute, checks the results, checks the
// Open-FDD app's hooks ran against the same model, and writes an evidence report (JSON, HTML, CSV).
//   node scripts/sim-validate.mjs [--nf http://localhost:8080] [--tests ahu.recirc,vav.max_cool]
//        [--hold-recirc 20] [--hold-max-cool 5] [--out evidence] [--signoff]
// Writes only through the app's own hooks, which bind only objects the sim hook created (names nfft-sim.*).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const sim = require('../hooks/lib/sim.js');
const simConfig = require('../hooks/lib/sim_site_config.js');
const { validateSiteConfig } = require('../hooks/lib/config');
const { modelFromBindings } = require('../hooks/lib/runtime.js');
const { buildPlan } = require('../hooks/lib/plan.js');
const { runnableSteps } = require('../hooks/lib/runner.js');
const { planHash } = require('../hooks/lib/signoff.js');
const E = require('../static/evidence.js');
const { renderHtml } = require('./evidence-html.cjs');

const APP = 'nf-hvac-functional-test';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, /** @type {[string, string][]} */ ([])));
const NF = String(args.nf || 'http://localhost:8080').replace(/\/$/, '');
const host = new URL(NF).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`refusing ${host}: this harness runs against a local NF with the simulator only`);
  process.exit(2);
}
const TESTS = String(args.tests || 'ahu.recirc,vav.max_cool').split(',').map((s) => s.trim()).filter(Boolean);
const HOLD = { 'ahu.recirc': Number(args['hold-recirc'] || 20), 'vav.max_cool': Number(args['hold-max-cool'] || 5) };
const OUT = path.resolve(args.out || path.join(here, '..', 'evidence'));
const SAMPLE_MS = Number(args['sample-s'] || 60) * 1000;
const TERMINAL = new Set(['COMPLETE', 'ABORTED', 'FAILED', 'IDLE']);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const log = (...m) => console.log(new Date().toISOString(), ...m);

async function api(p, body) {
  const res = await fetch(`${NF}${p}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${p} -> HTTP ${res.status}`);
  const t = await res.text();
  return t ? JSON.parse(t) : {};
}

function answerOf(run) {
  for (const g of Object.values(run.results || {})) {
    for (const k of ['returnValue', 'return_value', 'result', 'value']) {
      const raw = g && g[k];
      if (raw && typeof raw === 'object') return raw;
      if (typeof raw === 'string' && raw.trim().startsWith('{')) return JSON.parse(raw);
    }
  }
  const events = Object.values(run.results || {}).flatMap((g) => g.events || []);
  const last = [...events].reverse().find((e) => typeof e.message === 'string' && e.message.trim().startsWith('{'));
  return last ? JSON.parse(last.message) : null;
}

async function hook(app, name, a) {
  const body = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const started = await api(`/api/v1/apps/${app}/hooks/${name}`, body);
  for (let i = 0; i < 60; i += 1) {
    await sleep(i ? 700 : 300);
    const runs = (await api(`/api/v1/apps/${app}/hooks/${name}/runs?page_size=5&include_results=true&include_logs=true`)).runs || [];
    const run = runs.find((r) => r.pid === started.pid);
    if (!run || ['STATE_RUNNING', 'STATE_ENQUEUED', 'STATE_SCHEDULED'].includes(run.state)) continue;
    const ans = answerOf(run);
    if (!ans) throw new Error(`${name} ended ${run.state} with no answer`);
    return ans;
  }
  throw new Error(`${name} still running`);
}
const admin = (action, payload) => hook(APP, 'admin', { action, payload: payload || {} });

function nameOf(o) {
  const p = (o.props || []).find((x) => x.property === 'PROP_OBJECT_NAME');
  return (p && p.value && p.value.characterString) || '';
}
function pvOf(o) {
  const p = (o.props || []).find((x) => x.property === 'PROP_PRESENT_VALUE');
  const v = p && p.value;
  if (!v) return null;
  for (const k of ['real', 'double', 'unsigned', 'signed', 'enumerated']) if (k in v) return Number(v[k]);
  if ('boolean' in v) return v.boolean ? 1 : 0;
  return null;
}

const cat = sim.catalog(undefined, { layout: 'office' });
/** Sample keys: config equipment id : nfft role, plus the fan speed feedback (no nfft role on this unit). */
function keyMap(config) {
  const byUuid = new Map();
  for (const e of config.equipment) for (const [role, b] of Object.entries(e.points)) byUuid.set(b.uuid, `${e.id}:${role}`);
  return byUuid;
}

async function sample(keys, extraByName) {
  const listing = await api('/api/v1/bacnet/local');
  const v = {};
  for (const o of listing.objects || []) {
    const k = keys.get(o.uuid) || extraByName[nameOf(o)];
    if (k) v[k] = pvOf(o);
  }
  return v;
}

async function ftestCommands() {
  try {
    const body = await api('/api/v2/command');
    return (body.commands || []).filter((c) => String(c.name || '').startsWith('ftest-')).length;
  } catch {
    return null;
  }
}

async function waitIdle(maxMs) {
  const end = Date.now() + maxMs;
  for (;;) {
    const s = await admin('status');
    if (TERMINAL.has(s.state) && !s.pending_start) return s;
    if (Date.now() > end) throw new Error(`app busy: ${s.state}`);
    await sleep(15000);
  }
}

async function openFddEvidence(since) {
  const out = { app: null, hooks: [], fdd_rows: 0, fdd_fresh: 0, equipment_with_fdd: 0 };
  try {
    const apps = (await api('/api/v1/apps')).applications || [];
    const ofdd = apps.find((a) => /open-fdd/.test(a.id));
    if (!ofdd) return out;
    out.app = ofdd.id;
    for (const h of ofdd.hooks || []) {
      const runs = (await api(`/api/v1/apps/${ofdd.id}/hooks/${h.name}/runs?page_size=10`)).runs || [];
      const inWindow = runs.filter((r) => Date.parse(r.startTime || r.start_time || 0) >= since);
      out.hooks.push({ hook: h.name, runs_in_window: inWindow.length, states: [...new Set(inWindow.map((r) => r.state))], last_state: runs[0] ? runs[0].state : null });
    }
    const equips = new Set();
    for (let off = 0; ; off += 500) {
      const page = await api('/api/v1/point/query', { layer: 'model', page_size: 500, page_offset: off });
      for (const p of page.points || []) {
        const a = p.attrs || {};
        if (!/fdd/.test(a.markers || '') || !/^nfft-sim-(rtu-1|hw-plant-1|vav-\d-\d\d)$/.test(a.equipRef || '')) continue;
        out.fdd_rows += 1;
        if (Date.parse(a.fddLastRun || 0) >= since) { out.fdd_fresh += 1; equips.add(a.equipRef); }
      }
      if (!page.points || page.points.length < 500) break;
    }
    out.equipment_with_fdd = equips.size;
  } catch (err) {
    out.error = String(err.message || err);
  }
  return out;
}

async function runSequence(testId, config, keys, extra) {
  const plan = buildPlan(modelFromBindings(config), { ...config, plan: { ...config.plan, steps: [{ step_id: testId, enabled: true, hold_minutes: HOLD[testId], settle_minutes: 5 }, { step_id: 'recovery', enabled: true, hold_minutes: 1, settle_minutes: 0 }] } });
  const steps = plan.ready ? runnableSteps(plan, config) : [];
  const step = steps.find((s) => s.step_id === testId);
  const planned = plan.steps.find((s) => s.step_id === testId);
  const boxesPlanned = testId === 'vav.max_cool'
    ? (planned && planned.per_box ? planned.per_box : (step ? step.boxes : [])).map((b) => ({ id: b.equipment_id, strategy: b.strategy || 'unsupported', reason: b.reason, ok: Boolean(b.strategy) }))
    : [];
  await waitIdle(30 * 60000);
  const started = Date.now();
  log(`start ${testId} hold ${HOLD[testId]} min`);
  const startReply = await admin('start', { test_id: testId, hold_minutes: HOLD[testId], live: true, confirm_live: true });
  if (!startReply.ok) throw new Error(`start refused: ${startReply.code}`);
  const samples = [];
  const phases = [];
  let maxOverrides = 0;
  let maxCommands = 0;
  let seenActive = false;
  let last;
  const deadline = started + (HOLD[testId] + 5 + 20) * 60000;
  for (;;) {
    const t = Date.now();
    const [st, v, cmds] = await Promise.all([admin('status'), sample(keys, extra), ftestCommands()]);
    samples.push({ t, v, phase: st.state, step: st.step_index, commands: cmds });
    maxCommands = Math.max(maxCommands, cmds || 0);
    maxOverrides = Math.max(maxOverrides, st.overrides || 0);
    if (!phases.length || phases[phases.length - 1].phase !== st.state || phases[phases.length - 1].step !== st.step_index) {
      phases.push({ t, phase: st.state, step: st.step_index, step_started_at: st.step_started_at || null, reason: st.reason || '' });
      log(`${testId}: ${st.state} step ${st.step_index}${st.reason ? ` (${st.reason})` : ''}`);
    }
    last = st;
    if (st.state !== 'IDLE' && !TERMINAL.has(st.state)) seenActive = true;
    if (seenActive && TERMINAL.has(st.state)) break;
    if (t > deadline) { log(`${testId}: deadline, aborting`); await admin('abort', {}); break; }
    await sleep(Math.max(1000, SAMPLE_MS - (Date.now() - t)));
  }
  await sleep(SAMPLE_MS);
  const after = await ftestCommands();
  const stepPhase = phases.find((p) => p.phase === 'STEP' && p.step === 0) || phases.find((p) => p.step === 0);
  const stepStart = stepPhase ? (stepPhase.step_started_at || stepPhase.t) : started;
  const stepEndP = phases.find((p) => p.t > (stepPhase ? stepPhase.t : started) && (p.step !== 0 || TERMINAL.has(p.phase)));
  const stepEnd = stepEndP ? stepEndP.t : Date.now();
  const holdFrom = stepStart + 5 * 60000;
  const rows = E.window(samples, holdFrom, stepEnd);
  const ahu = config.equipment.find((e) => e.type === 'ahu').id;
  let checks;
  let extraOut = {};
  if (testId === 'ahu.recirc') checks = E.recircChecks(rows, ahu);
  else {
    const tail = rows.filter((s) => s.t >= stepEnd - 3 * 60000);
    const mc = E.maxCoolChecks(tail.length ? tail : rows, { ahu, boxes: boxesPlanned, curve: { ...sim.OFFICE_FAN, source: 'illustrative teaching fan sized to the 30 boxes (not an EnergyPlus run)' } });
    checks = mc.checks;
    extraOut = { boxes: mc.boxes, strategies: mc.strategies, operating_point: mc.operating_point };
  }
  const hookChecks = [
    { id: 'hook.completed', label: 'Sequence completed through the existing hooks', pass: last.state === 'COMPLETE', detail: `Final state ${last.state}${last.reason ? ` (${last.reason})` : ''}.` },
    { id: 'hook.wrote', label: 'Hook wrote its overrides as NF commands', pass: maxCommands > 0 || maxOverrides > 0, detail: `Up to ${maxCommands} ftest commands held at once.` },
    { id: 'hook.released', label: 'Every override released afterwards', pass: after === 0, detail: after === null ? 'Command list unavailable.' : `${after} ftest commands left after the run.` },
    { id: 'hook.attention', label: 'No operator attention needed', pass: !last.needs_attention, detail: last.needs_attention ? 'Run ended needing attention.' : 'Clean finish.' },
  ].map((c) => ({ ...c, status: c.pass ? 'pass' : 'fail' }));
  const all = [...hookChecks, ...checks];
  return {
    test_id: testId, run_id: last.run_id || startReply.run_id || '', started_at: new Date(started).toISOString(), ended_at: new Date(Date.now()).toISOString(),
    hold_minutes: HOLD[testId], settle_minutes: 5, hold_window: { from: new Date(holdFrom).toISOString(), to: new Date(stepEnd).toISOString(), samples: rows.length },
    verdict: E.verdict(all), checks: all, phases, samples, ...extraOut,
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const listing = await api('/api/v1/bacnet/local');
  const env = await api('/api/v1/platform/env?name=BACNET_PRIORITY').catch(() => ({}));
  const hit = (env.variables || []).find((x) => x && (x.id === 'BACNET_PRIORITY' || x.name === 'BACNET_PRIORITY'));
  const priority = hit ? Number(hit.integer !== undefined ? hit.integer : hit.string) : null;
  const built = simConfig.build(cat, listing, { priority: Number.isInteger(priority) ? priority : null });
  if (!built) throw new Error('simulator objects incomplete; wait for the sim hook to finish creating them');
  const v = validateSiteConfig(built.config);
  if (!v.ok) throw new Error(`sim config invalid: ${JSON.stringify(v.errors)}`);
  const config = v.config;
  const target = await admin('target');
  log(`target ${target.target}, plan ${String(target.plan_hash).slice(0, 12)}, local ${planHash(config).slice(0, 12)}`);
  const keys = keyMap(config);
  const ahuId = config.equipment.find((e) => e.type === 'ahu').id;
  const extra = { 'nfft-sim.rtu-1.sf-speed-fb': `${ahuId}:supply_fan_speed_feedback`, 'nfft-sim.rtu-1.sf-speed': `${ahuId}:supply_fan_speed_command`, 'nfft-sim.rtu-1.clg-cap': `${ahuId}:cooling_capacity` };
  const started = Date.now();
  const sequences = [];
  for (const t of TESTS) sequences.push(await runSequence(t, config, keys, extra));
  const openfdd = await openFddEvidence(started);
  const report = {
    schema: E.SCHEMA, generated_at: new Date().toISOString(), target: 'simulation', nf: 'local NF (localhost)',
    building: 'ACME building (sim mirror of a real two-floor office: 1 rooftop unit, 30 VAV boxes with hot-water reheat, 1 hot-water plant)',
    sim_step: '1 minute (sim hook runs every minute)', physics: 'illustrative teaching plant (fan law, box capacity, mixing, fan heat); not an EnergyPlus run',
    plan_hash: planHash(config), run_ids: sequences.map((s) => s.run_id), bound_points: built.bound,
    sequences: sequences.map(({ samples, ...rest }) => ({ ...rest, trend_rows: samples.length })),
    trends: Object.fromEntries(sequences.map((s) => [s.test_id, s.samples])),
    openfdd, verdict: sequences.every((s) => s.verdict === 'pass') ? 'pass' : 'fail',
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(OUT, `evidence-${stamp}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 1)}\n`);
  for (const s of sequences) {
    const k = [...new Set(s.samples.flatMap((r) => Object.keys(r.v)))].sort();
    fs.writeFileSync(`${base}-${s.test_id}.csv`, E.trendCsv(s.samples, k));
  }
  fs.writeFileSync(`${base}.html`, renderHtml(report));
  log(`verdict ${report.verdict}; wrote ${base}.json/.html/.csv`);
  if (args.signoff && report.verdict === 'pass') {
    const slim = { ...report, trends: undefined };
    const reply = await admin('signoff', { report: slim });
    log(`signoff: ${JSON.stringify(reply)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
