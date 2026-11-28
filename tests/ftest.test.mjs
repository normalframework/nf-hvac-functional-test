import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const oxigraph = require('../static/vendor/oxigraph/node.js');
const S = require('../static/s223.js');
const Tags = require('../static/tags-223p.js');
const vocab = require('../static/roles-223p.js');
const bind = require('../static/haystack-bind.js');
const Sys = require('../static/systems.js');
const Strategies = require('../static/ftest-strategies.js');
const F = require('../static/ftest.js');
const Def = require('../static/deficiencies.js');
const G = require('../static/graphic.js');

function loadDemo() {
  const rec = JSON.parse(fs.readFileSync(path.join(__dirname, '../static/demo-nf-records.json'), 'utf8'));
  const vm = require('node:vm');
  const ctx = { window: {}, self: {}, document: {}, module: { exports: {} }, exports: {}, console };
  ctx.window = ctx; ctx.self = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/vendor/open-fdd/model.js'), 'utf8'), ctx);
  const M = require('../static/model-source.js');
  const turtle = M.localTurtle({ model: rec.model, points: rec.points }, { toPoint: ctx.toPoint, modelToTurtle: ctx.modelToTurtle, rdfBaseOf: ctx.rdfBaseOf || (() => 'urn:nf:') });
  return Tags.buildModel(turtle, { oxigraph, s223: S, vocab, bind, scenarios: rec.scenarios });
}

function synthetic(opts) {
  const nAhu = opts.ahus || 1;
  const vavs = opts.vavs || [3];
  const heating = opts.heating !== false;
  const plant = opts.plant === true;
  const unknown = opts.unknown === true;
  const unassigned = opts.unassigned === true;
  const rec = { model: [{ uuid: 's', name: 'site', pointType: 'SITE', attrs: { id: 'site', dis: 'Site', markers: 'site' } }], points: [] };
  let n = 1;
  const uuid = () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
  rec.model[0].uuid = uuid();
  function eq(id, dis, markers, extra = {}) {
    rec.model.push({ uuid: uuid(), name: dis, pointType: 'EQUIPMENT', attrs: { id, dis, markers, siteRef: 'site', ...extra } });
  }
  function pt(equipRef, id, markers, latestValue, extra = {}) {
    rec.points.push({ uuid: uuid(), name: id, pointType: 'POINT', attrs: { id, dis: id, markers, siteRef: 'site', equipRef, kind: 'Number', ...extra }, latestValue });
  }
  for (let a = 1; a <= nAhu; a++) {
    const aid = `ahu-${a}`;
    eq(aid, `AHU-${a}`, 'equip,ahu');
    pt(aid, `${aid}.dat`, 'point,his,discharge,air,temp,sensor', 13, { unit: '°C' });
    pt(aid, `${aid}.mat`, 'point,his,mixed,air,temp,sensor', 20, { unit: '°C' });
    pt(aid, `${aid}.rat`, 'point,his,return,air,temp,sensor', 24, { unit: '°C' });
    pt(aid, `${aid}.oat`, 'point,his,outside,air,temp,sensor', 30, { unit: '°C' });
    pt(aid, `${aid}.dsp`, 'point,his,discharge,air,pressure,sensor', 250, { unit: 'Pa' });
    pt(aid, `${aid}.sf`, 'point,his,discharge,fan,run,sensor', 1);
    pt(aid, `${aid}.sf-cmd`, 'point,his,discharge,fan,run,cmd,writable', 1);
    pt(aid, `${aid}.sf-spd`, 'point,his,discharge,fan,vfd,speed,cmd,writable', 70, { unit: '%' });
    pt(aid, `${aid}.oa`, 'point,his,outside,damper,cmd,writable', 30, { unit: '%' });
    pt(aid, `${aid}.ra`, 'point,his,return,damper,cmd,writable', 70, { unit: '%' });
    pt(aid, `${aid}.clg`, 'point,his,cool,valve,cmd,writable', 40, { unit: '%' });
    if (heating || (Array.isArray(heating) && heating[a - 1])) pt(aid, `${aid}.htg`, 'point,his,heat,valve,cmd,writable', 0, { unit: '%' });
    const count = Array.isArray(vavs) ? (vavs[a - 1] ?? vavs[0]) : vavs;
    for (let i = 1; i <= count; i++) {
      const vid = `vav-${a}-${i}`;
      eq(vid, `VAV ${a}-${i}`, 'equip,vav,airTerminalUnit', { airRef: aid });
      pt(vid, `${vid}.dmp-cmd`, 'point,his,damper,cmd,writable', 50, { unit: '%' });
      pt(vid, `${vid}.dmp`, 'point,his,damper,sensor', 50, { unit: '%' });
      pt(vid, `${vid}.flow`, 'point,his,discharge,air,flow,sensor', 100);
      pt(vid, `${vid}.flow-max`, 'point,his,discharge,max,air,flow,sp', 200);
      pt(vid, `${vid}.flow-sp`, 'point,his,discharge,air,flow,sp,writable', 100);
    }
  }
  if (plant) {
    eq('boiler-1', 'Boiler', 'equip,boiler');
    pt('boiler-1', 'boiler-1.run', 'point,his,boiler,run,sensor', 1);
    eq('pump-1', 'HW pump', 'equip,pump,hot,water', { feeds: 'ahu-1' });
    pt('pump-1', 'pump-1.run', 'point,his,pump,run,sensor', 1);
  }
  if (unknown) {
    eq('mystery-1', 'Mystery pack', 'equip,mystery');
    pt('mystery-1', 'mystery-1.x', 'point,his,sensor', 1);
  }
  if (unassigned) {
    eq('vav-x', 'Loose VAV', 'equip,vav,airTerminalUnit');
    pt('vav-x', 'vav-x.dmp-cmd', 'point,his,damper,cmd,writable', 40);
    pt('vav-x', 'vav-x.dmp', 'point,his,damper,sensor', 40);
    pt('vav-x', 'vav-x.flow', 'point,his,discharge,air,flow,sensor', 10);
  }
  const fs2 = require('node:fs');
  const vm = require('node:vm');
  const ctx = { module: { exports: {} }, exports: {}, console };
  ctx.window = ctx; ctx.self = ctx;
  vm.runInNewContext(fs2.readFileSync(path.join(__dirname, '../static/vendor/open-fdd/model.js'), 'utf8'), ctx);
  const M = require('../static/model-source.js');
  const turtle = M.localTurtle({ model: rec.model, points: rec.points }, { toPoint: ctx.toPoint, modelToTurtle: ctx.modelToTurtle, rdfBaseOf: ctx.rdfBaseOf || (() => 'urn:nf:') });
  return Tags.buildModel(turtle, { oxigraph, s223: S, vocab, bind });
}

test('demo fixture has two air handlers, an unassigned VAV, and a HW plant', () => {
  const m = loadDemo();
  const g = Sys.fromModel(m);
  assert.equal(g.systems.length, 2);
  assert.ok(g.systems[0].terminals.length === 3);
  assert.ok(g.systems[1].terminals.length === 8);
  assert.equal(g.unassigned.length, 1);
  assert.match(g.unassigned[0].label, /VAV-99/);
  assert.ok((m.plants || []).some((p) => p.kind === 'boiler' || /boiler/i.test(p.label)));
});

test('scene builder: 0, 1, 3 and 12 VAVs, with and without a heating coil, plant present or absent, unknown equipment', () => {
  const cases = [
    { vavs: [0], heating: false, plant: false },
    { vavs: [1], heating: true, plant: false },
    { vavs: [3], heating: true, plant: true },
    { vavs: [12], heating: false, plant: false, unknown: true },
  ];
  for (const c of cases) {
    const m = synthetic(c);
    const unit = m.ahus[0];
    const L = G.layout(unit, S.points, m);
    assert.equal(L.terminals.length, c.vavs[0], `vavs ${c.vavs}`);
    const kinds = new Set(L.elements.map((e) => e.kind));
    if (c.heating) assert.ok([...kinds].some((k) => /heating_coil/.test(k)), 'heating coil drawn');
    else assert.ok(![...kinds].some((k) => /heating_coil/.test(k)), 'no invented heating coil');
    if (c.plant) assert.ok((L.plants || []).length + (L.pipes || []).length > 0, 'plant/pipes present');
    if (c.unknown) assert.ok((m.other || []).length >= 1, 'unknown equipment kept');
    if (c.vavs[0] > 1) {
      const xs = L.terminals.map((t) => t.box[0]);
      assert.ok(xs.slice(1).every((x, i) => x >= xs[i]), 'terminals laid out along the trunk');
    }
  }
});

test('scene builder: sites with 1, 2 and 5 AHUs plus an unassigned VAV', () => {
  for (const n of [1, 2, 5]) {
    const m = synthetic({ ahus: n, vavs: Array.from({ length: n }, (_, i) => (i === 0 ? 3 : 1)), unassigned: true });
    const g = Sys.fromModel(m);
    assert.equal(g.systems.length, n);
    assert.ok(g.unassigned.length >= 1, 'unassigned VAV is listed');
    assert.ok(g.unassigned.some((t) => /loose|vav-x/i.test(t.label + t.id)));
    const assess = F.assessSystem(g.unassigned[0], { unassigned: true });
    assert.equal(assess.testable, false);
  }
});

test('what can be tested: mixed strategies, and missing points are listed', () => {
  const m = loadDemo();
  const g = Sys.fromModel(m);
  const ahu1 = g.systems.find((s) => /AHU-1/.test(s.label)) || g.systems[0];
  const assess = F.assessSystem(ahu1.unit, { points: S.points });
  const cool = assess.tests.find((t) => t.test === 'vav.max_cool');
  assert.ok(cool.testable >= 1);
  // Auto-detect should pick setpoint / boolean / mode when those points bound.
  assert.ok(cool.boxes.every((b) => b.ok ? b.strategy : b.missing.length));
  const loose = F.assessSystem({ id: 'x', label: 'loose', unassigned: true, terminals: [] });
  assert.equal(loose.testable, false);
});

test('explicit vendor-A / vendor-B override config is honoured per box', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/mixed-vendor-vav-overrides.json'), 'utf8'));
  const boxA = { id: 'vav-01', points: {
    discharge_air_volume_flow_rate_setpoint: { role: 'discharge_air_volume_flow_rate_setpoint', writable: true },
    discharge_air_volume_flow_rate: { role: 'discharge_air_volume_flow_rate' },
  } };
  const boxB = { id: 'vav-02', points: {
    purge_operating_mode_command: { role: 'purge_operating_mode_command', writable: true },
    discharge_air_volume_flow_rate: { role: 'discharge_air_volume_flow_rate' },
  } };
  const boxC = { id: 'vav-03', points: {
    maximum_cooling_operating_mode_command: { role: 'maximum_cooling_operating_mode_command', writable: true },
    discharge_air_volume_flow_rate: { role: 'discharge_air_volume_flow_rate' },
  } };
  const boxX = { id: 'vav-x', points: { discharge_air_volume_flow_rate: { role: 'discharge_air_volume_flow_rate' } } };
  assert.equal(Strategies.resolveBox(boxA, cfg).strategy, 'write_airflow_setpoint');
  assert.equal(Strategies.resolveBox(boxB, cfg).strategy, 'toggle_boolean');
  assert.equal(Strategies.resolveBox(boxC, cfg).strategy, 'set_multistate');
  const miss = Strategies.resolveBox(boxX, {});
  assert.equal(miss.ok, false);
  assert.ok(miss.missing.join(' ').includes('setpoint') || miss.missing.length > 0);
});

test('max-cooling evaluation flags a starved box, open damper / low flow, static and fan-at-max', () => {
  const assessment = {
    boxes: [
      { equipment_id: 'vav-01', label: 'VAV-01', ok: true, strategy: 'write_airflow_setpoint', target: 200 },
      { equipment_id: 'vav-03', label: 'VAV-03', ok: true, strategy: 'set_multistate', target: 180 },
    ],
  };
  const fail = F.maxCooling.evaluate(assessment, {
    values: {
      'vav-01:discharge_air_volume_flow_rate': 190,
      'vav-03:discharge_air_volume_flow_rate': 70,
      'vav-03:damper_position': 100,
    },
    staticPa: 20,
    staticSp: 250,
    fanSpeed: 100,
    fanOn: true,
  });
  assert.equal(fail.ok, false);
  const bad = fail.results.find((r) => r.equipment_id === 'vav-03');
  assert.ok(bad.deficiencies.some((d) => d.kind === 'starved_box'));
  assert.ok(bad.deficiencies.some((d) => d.kind === 'damper_open_low_flow'));
  assert.ok(fail.systemDeficiencies.some((d) => d.kind === 'static_not_maintained'));
  assert.ok(fail.systemDeficiencies.some((d) => d.kind === 'fan_at_max'));
  const pass = F.maxCooling.evaluate(assessment, {
    values: {
      'vav-01:discharge_air_volume_flow_rate': 190,
      'vav-03:discharge_air_volume_flow_rate': 175,
    },
    staticPa: 240,
    staticSp: 250,
    fanSpeed: 80,
  });
  assert.equal(pass.ok, true);
});

test('deficiencies: command vs feedback, stale, out of range, failed step', () => {
  const now = 1_000_000;
  const points = [
    { id: 'c1', equipment: 'vav-01', role: 'damper_position_command', part: 'dmp', label: 'cmd' },
    { id: 'f1', equipment: 'vav-01', role: 'damper_position', part: 'dmp', label: 'fb' },
    { id: 't1', equipment: 'ahu-1', role: 'discharge_air_temperature', part: 'sat', label: 'SAT' },
    { id: 'p1', equipment: 'ahu-1', role: 'discharge_air_static_pressure', part: 'fan', label: 'static' },
  ];
  const found = Def.detect(points, {
    c1: { value: 100, ts: now },
    f1: { value: 38, ts: now },
    t1: { value: 13, ts: now - 60 * 60 * 1000 },
    p1: { value: 9000, ts: now },
  }, { now, staleAfterMs: 15 * 60 * 1000, failedSteps: [{ equipment_id: 'vav-01', kind: 'failed_step', message: 'Starved', label: 'VAV-01' }] });
  const kinds = found.map((d) => d.kind).sort();
  assert.ok(kinds.includes('command_feedback_mismatch'));
  assert.ok(kinds.includes('stale'));
  assert.ok(kinds.includes('out_of_range'));
  assert.ok(kinds.includes('failed_step'));
});

test('liveFrame is display-only and stops flow when readings are missing or the fan is off', () => {
  const m = synthetic({ vavs: [1] });
  const unit = m.ahus[0];
  const pts = S.points(unit);
  const values = Object.fromEntries(pts.map((p) => [p.id, 0]));
  const fan = pts.find((p) => p.role === 'supply_fan_operating_status' || p.role === 'supply_fan_command');
  if (fan) values[fan.id] = 0;
  const frame = G.liveFrame(unit, S.points, values);
  assert.equal(frame.scene.fanOn, false);
  assert.equal(frame.scene.terminals.length, 1);
});

test('legacy plan strategy aliases still resolve', () => {
  assert.equal(Strategies.canonical('airflow_setpoint'), 'write_airflow_setpoint');
  assert.equal(Strategies.canonical('flush_point'), 'toggle_boolean');
  assert.ok(Strategies.get('write_airflow_setpoint'));
});


test('systems.find returns the unassigned group or a named system', () => {
  const m = loadDemo();
  const g = Sys.fromModel(m);
  const loose = Sys.find(g, 'unassigned');
  assert.equal(loose.kind, 'unassigned_group');
  assert.ok(loose.unassigned);
  assert.ok(loose.terminals.length >= 1);
  const named = Sys.find(g, g.systems[0].id);
  assert.equal(named.id, g.systems[0].id);
  const fallback = Sys.find(g, 'does-not-exist');
  assert.equal(fallback.id, g.systems[0].id);
  const empty = Sys.fromModel({});
  assert.equal(empty.systems.length, 0);
  assert.equal(Sys.find(empty, 'x'), null);
});

test('an other-equipment terminal with no feed is grouped as unassigned', () => {
  const g = Sys.fromModel({
    ahus: [{ id: 'ahu-1', label: 'AHU-1', iri: 'urn:ahu-1', terminals: [{ id: 'vav-1', iri: 'urn:vav-1', label: 'VAV-1' }] }],
    unassigned: [],
    other: [
      { id: 'vav-x', iri: 'urn:vav-x', label: 'Loose', kind: 'terminal_unit' },
      { id: 'vav-1', iri: 'urn:vav-1', label: 'Already assigned', kind: 'terminal_unit' },
      { id: 'pump-1', iri: 'urn:pump-1', label: 'Pump', kind: 'pump' },
    ],
    warnings: [],
  });
  assert.equal(g.systems.length, 1);
  assert.equal(g.unassigned.length, 1);
  assert.equal(g.unassigned[0].id, 'vav-x');
  assert.equal(g.unassigned[0].reason, 'no_feed_relationship');
});

test('unknown, unsupported, and shared AHU-level strategies resolve and command', () => {
  const ahu = { id: 'ahu-1', points: { maximum_cooling_operating_mode_command: { role: 'maximum_cooling_operating_mode_command', writable: true } } };
  const box = { id: 'vav-01', points: { discharge_air_volume_flow_rate: { role: 'discharge_air_volume_flow_rate' } } };
  const none = Strategies.resolveBox(box, { equipment: [{ id: 'vav-01', vav_override: { strategy: 'unsupported' } }] });
  assert.equal(none.strategy, 'unsupported');
  assert.equal(none.ok, false);
  const unknown = Strategies.resolveBox(box, { equipment: [{ id: 'vav-01', vav_override: { strategy: 'not_a_real_strategy' } }] });
  assert.match(unknown.reason, /unknown_strategy/);
  const shared = Strategies.resolveBox(box, null, { ahu, order: ['bas_toggle'] });
  assert.equal(shared.ok, true);
  assert.equal(shared.strategy, 'bas_toggle');
  assert.equal(shared.shared, true);
  const cmd = Strategies.get('bas_toggle').command(shared);
  assert.equal(cmd.shared, true);
  assert.equal(cmd.role, 'maximum_cooling_operating_mode_command');
  const empty = Strategies.resolveBox({ id: 'vav-z', points: {} }, null, { order: ['bas_toggle', 'write_airflow_setpoint'] });
  assert.equal(empty.ok, false);
});

test('findOverride matches a Haystack-style id against a labeled box', () => {
  const cfg = { equipment: [{ id: 'vav-03', vav_override: { strategy: 'set_multistate', role: 'maximum_cooling_operating_mode_command', value: 1, release: 0 } }] };
  const box = {
    id: '42bd2c63-7b17-5cab-a3bb-f4535fc652fb',
    label: 'VAV-03 Corridor',
    points: {
      maximum_cooling_operating_mode_command: { role: 'maximum_cooling_operating_mode_command', writable: true },
      discharge_air_volume_flow_rate: { role: 'discharge_air_volume_flow_rate' },
    },
  };
  const got = Strategies.resolveBox(box, cfg);
  assert.equal(got.ok, true);
  assert.equal(got.strategy, 'set_multistate');
});
