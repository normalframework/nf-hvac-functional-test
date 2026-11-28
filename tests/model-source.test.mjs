import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const oxigraph = require('../static/vendor/oxigraph/node.js');
const S = require('../static/s223.js');
const vocab = require('../static/roles-223p.js');
const bind = require('../static/haystack-bind.js');
const D = require('../static/tags-223p.js');
const M = require('../static/model-source.js');
const T = require('../static/graphic.js');
const paging = require('../static/vendor/open-fdd/paging.js');

const ROOT = path.join(__dirname, '..');
const RECORDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'static', 'demo-nf-records.json'), 'utf8'));
// Open-FDD's real rdf hook (release/5.0.22), run against the fake NF below.
const openFddRdf = require('./fixtures/open-fdd/hooks/rdf.js');

/** Open-FDD's model.js the way its hooks load it (a sandbox), from this repo's vendored copy. */
function modelJs() {
  const ctx = vm.createContext({ console, URLSearchParams, TextDecoder, atob, btoa });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'static', 'vendor', 'open-fdd', 'model.js'), 'utf8'), ctx);
  const get = (n) => vm.runInContext(n, ctx);
  return { toPoint: get('toPoint'), idOf: get('idOf'), ENTITY_TYPES: get('ENTITY_TYPES'), modelToTurtle: get('modelToTurtle'), rdfBaseOf: get('rdfBaseOf') };
}

/** A fake NF: point/query over a mutable record set, counting every request. Read-only by construction. */
function fakeNf(records = structuredClone(RECORDS)) {
  const calls = [];
  const query = (body) => {
    calls.push({ path: '/api/v1/point/query', body });
    let list = body.layer === 'model' ? records.model : records.points;
    const f = body.structuredQuery && body.structuredQuery.field;
    if (f) list = list.filter((r) => (r.attrs || {})[f.property] === f.text);
    const offset = body.pageOffset || 0;
    const size = body.pageSize || 500;
    return { points: list.slice(offset, offset + size), totalCount: String(list.length) };
  };
  return {
    records,
    calls,
    http: { post: async (p, body) => { assert.equal(p, '/api/v1/point/query'); return { data: query(body) }; } },
    queryAll: (body) => paging.pageAll(async (p) => query({ ...body, ...p }), { key: 'points', what: 'point/query' }),
  };
}

/** Open-FDD installed on the fake NF: its hook answers through the NF hook API shape. */
function openFdd(nf, state = { installed: true }) {
  const runs = [];
  const call = async (hook, args) => {
    runs.push({ hook, args });
    if (!state.installed) throw new Error('/api/v1/apps/open-fdd/hooks/rdf -> HTTP 404');
    if (state.hang) return new Promise(() => {});
    if (state.shape === 'v6') return { ok: true, graph: 'urn:x', data: '...' };
    assert.equal(hook, 'rdf', 'only the read-only rdf hook is ever called');
    return openFddRdf.handle({ sdk: { http: nf.http, logEvent: () => {} }, args });
  };
  return { call, runs, state };
}

const shared = modelJs();
const build = (turtle) => D.buildModel(turtle, { oxigraph, s223: S, vocab, bind });
function source(nf, ofdd, extra = {}) {
  let t = 0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const src = M.createModelSource({
    callOpenFddHook: ofdd ? ofdd.call : null,
    loadRecords: () => M.loadRecords(nf.queryAll, shared.idOf),
    modelJs: shared,
    build,
    now: clock.now,
    timeoutMs: 200,
    pageTimeoutMs: 200,
    ...extra,
  });
  return { src, clock };
}

test('vendored Open-FDD modules are byte-identical to release/5.0.22', () => {
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
  assert.equal(sha('static/vendor/open-fdd/model.js'), '862d6b9ff3af5166dd005c4e8df68e90a216f2e6f2a7e323391e2b24c9f3c188');
  assert.equal(sha('static/vendor/open-fdd/paging.js'), 'a9f6d3ad3dd1500b1bdf577222342b832d5a6c2edb97d396722edb94c61e34dc');
  assert.equal(sha('tests/fixtures/open-fdd/static/model.js'), sha('static/vendor/open-fdd/model.js'));
  assert.equal(sha('vendor/roles/openfdd-roles.json'), '43717ebc6187f678e3ee424b5e877f14dcd92e387bfdcedd7cbdb2f9b5eb85c1');
});

test('NF tags derive the whole graphic: two air handlers, unassigned VAV, every point bound to one Open-FDD role', () => {
  const turtle = M.localTurtle(RECORDS, shared);
  const m = build(turtle);
  assert.deepEqual(m.report, { unbound: [], ambiguous: [], duplicates: [] });
  assert.ok(m.warnings.some((w) => /VAV-99|not fed by an air handler|no airRef/i.test(w)));
  assert.equal(m.ahus.length, 2);
  assert.equal(m.bindings.length, RECORDS.points.length);
  assert.deepEqual(m.properties.unmatched, []);
  assert.deepEqual(m.properties.ambiguous, []);
  const ahu = m.ahus.find((a) => a.label === 'AHU-1') || m.ahus[0];
  assert.equal(ahu.label, 'AHU-1');
  assert.deepEqual(ahu.terminals.map((t) => t.label), ['VAV-01 Office', 'VAV-02 Conference', 'VAV-03 Corridor']);
  const onPath = ahu.parts.filter((p) => p.layer != null).sort((a, b) => a.layer - b.layer || a.lane - b.lane).map((p) => p.kind);
  assert.deepEqual(onPath, ['damper', 'damper', 'junction', 'filter', 'cooling_coil', 'heating_coil', 'fan']);
  const ahu2 = m.ahus.find((a) => a.label === 'AHU-2');
  assert.equal(ahu2.terminals.length, 8);
  assert.ok(!(ahu2.parts || []).some((p) => /heating_coil/.test(p.kind)), 'AHU-2 has no heating coil');
  assert.ok((m.unassigned || []).length >= 1);
  assert.ok((m.plants || []).some((p) => p.kind === 'boiler' || /boiler/i.test(p.label)));
  // The 223P round trip: the role the tags bound is the role the 223P pattern matches.
  const pts = S.allPoints(m);
  for (const b of m.bindings) {
    const hit = pts.find((p) => p.id === b.point);
    assert.ok(hit, b.label);
    assert.equal(hit.role, b.role, b.label);
  }
  assert.ok(pts.every((p) => RECORDS.points.some((r) => r.uuid === p.id)));
});

test('the derived model drives the same sim and stroke test', () => {
  const m = build(M.localTurtle(RECORDS, shared));
  const vav3 = RECORDS.model.find((r) => r.attrs.id === 'vav-03').uuid;
  const scen = D.buildModel(M.localTurtle(RECORDS, shared), { oxigraph, s223: S, vocab, bind, scenarios: [{ equip: vav3, part: 's223:Damper', spec: 'stuck:38' }] }).scenarios;
  const values = Object.fromEntries(RECORDS.points.map((r) => [r.uuid, r.latestValue]));
  const sim = T.createSim(m.ahus[0], { points: S.points, values, faults: Object.fromEntries(scen.map((x) => [x.part, x.spec])) });
  assert.deepEqual(sim.binding.terminals.map((t) => t.maxLps), [425, 600, 180]);
  sim.settle();
  const r = T.runStroke(sim, T.strokePlan(sim));
  assert.equal(r.outcome, 'fail');
  const bad = r.results.filter((x) => !x.pass);
  assert.deepEqual(bad.map((x) => [x.label, x.target, x.feedback, x.cause]), [['VAV-03 Corridor', 100, 38, 'actuator_binding']]);
  assert.equal(r.release.ok, true);
});

test('alone: no Open-FDD, the built-in graph is built from NF tags', async () => {
  const nf = fakeNf();
  const { src } = source(nf, null);
  const got = await src.get();
  assert.equal(got.source, 'built-in');
  assert.equal(got.model.ahus[0].terminals.length, 3);
  assert.equal(src.stats().builds, 1);
  assert.ok(nf.calls.every((c) => c.path === '/api/v1/point/query'));
});

test('alone: Open-FDD not installed (404) falls back the same way', async () => {
  const nf = fakeNf();
  const ofdd = openFdd(nf, { installed: false });
  const { src } = source(nf, ofdd);
  const got = await src.get();
  assert.equal(got.source, 'built-in');
  assert.match(got.note, /404/);
});

test('together: Open-FDD present, its graph is read and no second graph is built from records', async () => {
  const nf = fakeNf();
  const ofdd = openFdd(nf);
  const { src } = source(nf, ofdd);
  const got = await src.get();
  assert.equal(got.source, 'open-fdd');
  assert.equal(got.model.ahus[0].terminals.length, 3);
  assert.deepEqual(ofdd.runs.map((r) => r.hook), ['rdf']);
  // Same snapshot as the built-in path: Open-FDD's sha256 of the same Turtle.
  assert.equal(got.snapshot, M.sha256(M.localTurtle(nf.records, shared)));
});

test('together: cached between re-checks, and an unchanged snapshot costs Open-FDD one first-page run, no rebuild', async () => {
  const nf = fakeNf();
  const ofdd = openFdd(nf);
  const { src, clock } = source(nf, ofdd);
  await src.get();
  await src.get();
  assert.equal(ofdd.runs.length, 1, 'no run inside the re-check window');
  clock.advance(src.recheckMs);
  const again = await src.get();
  assert.equal(again.rebuilt, false);
  assert.equal(ofdd.runs.length, 2);
  assert.equal(src.stats().builds, 1);
  const [a, b] = await Promise.all([src.get({ force: true }), src.get({ force: true })]);
  assert.equal(a, b, 'concurrent checks share one run');
  assert.equal(ofdd.runs.length, 3);
});

test('NF tag change rebuilds once; a name-only value change does not', async () => {
  const nf = fakeNf();
  const ofdd = openFdd(nf);
  const { src, clock } = source(nf, ofdd);
  await src.get();
  nf.records.points[0].latestValue = 99;
  clock.advance(src.recheckMs);
  assert.equal((await src.get()).rebuilt, false, 'values are not tags');
  const p = nf.records.points.find((r) => r.attrs.id === 'vav-02.dmp');
  p.attrs.markers = 'point,his';
  clock.advance(src.recheckMs);
  const changed = await src.get();
  assert.equal(changed.rebuilt, true);
  assert.equal(src.stats().builds, 2);
  assert.ok(changed.model.report.unbound.includes(p.uuid));
});

test('Open-FDD going away mid-session: next re-check falls back without a rebuild or reconfiguration', async () => {
  const nf = fakeNf();
  const ofdd = openFdd(nf);
  const { src, clock } = source(nf, ofdd);
  const first = await src.get();
  assert.equal(first.source, 'open-fdd');
  ofdd.state.installed = false;
  clock.advance(src.recheckMs);
  const after = await src.get();
  assert.equal(after.source, 'built-in');
  assert.equal(after.rebuilt, false, 'same tags, same snapshot, same model');
  assert.equal(after.model, first.model);
  ofdd.state.installed = true;
  clock.advance(src.recheckMs);
  const back = await src.get();
  assert.equal(back.source, 'open-fdd');
  assert.equal(src.stats().builds, 1);
});

test('Open-FDD hanging or upgraded to an unknown answer: short timeout, then the built-in graph', async () => {
  const nf = fakeNf();
  const hang = openFdd(nf, { installed: true, hang: true });
  const t0 = Date.now();
  const got = await source(nf, hang).src.get();
  assert.equal(got.source, 'built-in');
  assert.match(got.note, /did not answer within 200 ms/);
  assert.ok(Date.now() - t0 < 2000);
  const upgraded = openFdd(nf, { installed: true, shape: 'v6' });
  const g2 = await source(nf, upgraded).src.get();
  assert.equal(g2.source, 'built-in');
  assert.match(g2.note, /unknown shape/);
});

test('large Open-FDD graphs are paged with its snapshot and checked end to end', async () => {
  const nf = fakeNf();
  const ofdd = openFdd(nf);
  const { src } = source(nf, ofdd, { pageLimit: 4000 });
  const got = await src.get();
  assert.equal(got.source, 'open-fdd');
  assert.ok(ofdd.runs.length > 3);
  assert.ok(ofdd.runs.slice(1).every((r) => r.args.snapshot === got.snapshot));
});

test('client checks: bad answers, short pages and drift are refused', async () => {
  const ok = (over) => async () => ({ ok: true, snapshot: 'x', turtle: 'a', next_offset: null, offset: 0, ...over });
  await assert.rejects(M.readOpenFdd(async () => ({ ok: false, error: 'boom' }), { known: null, signal: null, pageLimit: 1, maxPages: 2 }), /boom/);
  await assert.rejects(M.readOpenFdd(ok({}), { known: null, signal: null, pageLimit: 1, maxPages: 2 }), /changed or was cut/);
  const turtle = 'abc';
  const snap = M.sha256(turtle);
  assert.deepEqual(await M.readOpenFdd(ok({ snapshot: snap, turtle }), { known: snap, signal: null, pageLimit: 1, maxPages: 2 }), { snapshot: snap, turtle: null, pages: 1 });
  let n = 0;
  const endless = async () => ({ ok: true, snapshot: snap, turtle: 'a', next_offset: ++n, offset: n - 1 });
  await assert.rejects(M.readOpenFdd(endless, { known: null, signal: null, pageLimit: 1, maxPages: 3 }), /larger than/);
  const skew = async (h, args) => ({ ok: true, snapshot: snap, turtle: 'a', next_offset: args.offset === '0' ? 1 : null, offset: 7 });
  await assert.rejects(M.readOpenFdd(skew, { known: null, signal: null, pageLimit: 1, maxPages: 3 }), /out of step/);
});
