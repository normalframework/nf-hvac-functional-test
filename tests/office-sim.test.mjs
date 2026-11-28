import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sim = require('../hooks/lib/sim.js');
const office = require('../hooks/lib/sim_office.js');
const roles = require('../hooks/lib/openfdd_roles.js');
const simConfig = require('../hooks/lib/sim_site_config.js');
const signoff = require('../hooks/lib/signoff.js');
const E = require('../static/evidence.js');
const { validateSiteConfig } = require('../hooks/lib/config');
const { modelFromBindings, parseSiteConfig } = require('../hooks/lib/runtime.js');
const { buildPlan } = require('../hooks/lib/plan.js');
const { runnableSteps } = require('../hooks/lib/runner.js');

const cat = sim.catalog(undefined, { layout: 'office' });
const fakeListing = () => ({ objects: cat.points.map((p, i) => ({ uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, props: [{ property: 'PROP_OBJECT_NAME', value: { characterString: p.name } }] })) });

test('office catalog mirrors the generic layout: 1 rooftop unit, 1 plant, 30 boxes', () => {
  const kinds = cat.equipment.map((e) => e.markers);
  assert.equal(kinds.filter((m) => m.includes('ahu')).length, 1);
  assert.equal(kinds.filter((m) => m.includes('airTerminalUnit')).length, 30);
  assert.equal(kinds.filter((m) => m.includes('plant')).length, 1);
  assert.equal(cat.site.dis, 'ACME building');
});

test('vendor-b boxes keep the read-only airflow setpoint; five get a purge point, three none', () => {
  const zones = office.LAYOUT.zones;
  const counts = { flow_sp: 0, purge: 0, none: 0 };
  for (const z of zones) counts[office.overrideOf(z)] += 1;
  assert.deepEqual(counts, { flow_sp: 22, purge: 5, none: 3 });
});

test('stepOffice: max cooling raises the fan speed, holds duct static and keeps headroom', () => {
  let v = sim.initialValues(cat);
  for (let i = 0; i < 8; i += 1) v = sim.stepPhysics(v, cat);
  const before = v['rtu-1.sf-speed-fb'];
  for (const k of Object.keys(v)) {
    const m = k.match(/^(vav-.*)\.flow-sp$/);
    if (m) v[k] = v[`${m[1]}.flow-max`];
    if (k.endsWith('.purge-cmd')) v[k] = 1;
  }
  for (let i = 0; i < 10; i += 1) v = sim.stepPhysics(v, cat);
  assert.ok(v['rtu-1.sf-speed-fb'] > before + 20);
  assert.ok(v['rtu-1.sf-speed-fb'] < 95);
  assert.ok(Math.abs(v['rtu-1.dsp'] - 175) < 17.5, `static ${v['rtu-1.dsp']}`);
  const q = Object.keys(v).filter((k) => /^vav-.*\.flow$/.test(k)).reduce((t, k) => t + v[k], 0);
  assert.ok(q > 9000 && q < 10100, `flow ${q}`);
});

test('stepOffice: recirculation makes MAT track RAT and DAT carry fan heat', () => {
  let v = { ...sim.initialValues(cat), 'rtu-1.oa-dmp-cmd': 0, 'rtu-1.ra-dmp-cmd': 100, 'rtu-1.clg-vlv-cmd': 0, 'rtu-1.htg-vlv-cmd': 0 };
  for (let i = 0; i < 6; i += 1) v = sim.stepPhysics(v, cat);
  assert.ok(Math.abs(v['rtu-1.mat'] - v['rtu-1.rat']) <= 0.5);
  const rise = v['rtu-1.dat'] - v['rtu-1.mat'];
  assert.ok(rise > 0 && rise < 2, `rise ${rise}`);
});

test('Open-FDD roles: most sim points bind to a 223P role, gaps are reported', () => {
  const c = roles.conformance(cat);
  assert.equal(c.release, '5.0.22');
  assert.ok(c.s223 > 250);
  const gaps = c.rows.filter((r) => r.gap).map((r) => r.id.split('.').slice(1).join('.'));
  assert.ok(gaps.includes('sf-speed-fb'));
  assert.ok(gaps.includes('dp'));
  assert.equal(roles.matchRole('discharge,air,temp,sensor', 'equip,vav,airTerminalUnit').role, 'terminal_unit_discharge_air_temperature');
  assert.equal(roles.matchRole('discharge,air,temp,sensor', 'equip,ahu').role, 'air_handling_unit_discharge_air_temperature');
});

test('sim site config binds only sim objects and plans every sequence with per-box fallbacks', () => {
  assert.equal(simConfig.build(cat, { objects: [] }), null);
  const built = simConfig.build(cat, fakeListing());
  const v = validateSiteConfig(built.config);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const plan = buildPlan(modelFromBindings(v.config), v.config);
  assert.ok(plan.ready);
  assert.deepEqual(plan.steps.map((s) => s.status), ['included', 'included', 'included', 'included', 'included']);
  const vav = runnableSteps(plan, v.config).find((s) => s.step_id === 'vav.max_cool');
  const by = {};
  for (const b of vav.boxes) by[b.strategy || 'unsupported'] = (by[b.strategy || 'unsupported'] || 0) + 1;
  assert.deepEqual(by, { airflow_setpoint: 22, flush_point: 5, unsupported: 3 });
});

test('simulation target uses only the sim config; live target only the siteConfig option', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nfft-target-'));
  const built = simConfig.build(cat, fakeListing());
  simConfig.save(root, built.config);
  const armed = { enableSimulator: true, simulatorConfirm: sim.CONFIRM_PHRASE };
  assert.equal(parseSiteConfig({ options: { ...armed, testTarget: 'simulation', siteConfig: '{"version":1}' }, stateRoot: root }).equipment.length, 31);
  assert.equal(parseSiteConfig({ options: { ...armed, testTarget: 'live' }, stateRoot: root }), null);
  assert.equal(parseSiteConfig({ options: { testTarget: 'simulation' }, stateRoot: root }), null);
});

test('live writes need a signed-off simulation run of the same plan fingerprint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nfft-signoff-'));
  const config = validateSiteConfig(simConfig.build(cat, fakeListing()).config).config;
  const live = { testTarget: 'live' };
  assert.equal(signoff.gate(root, live, config, { live: true }).code, 'sim_signoff_required');
  assert.ok(signoff.gate(root, live, { ...config, dry_run: true }, { live: true }).ok, 'dry run stays allowed');
  const report = { schema: E.SCHEMA, target: 'simulation', verdict: 'pass', plan_hash: signoff.planHash(config), run_ids: ['r1'], sequences: [] };
  assert.equal(signoff.signOff(root, { ...report, verdict: 'fail' }, config).code, 'not_passed');
  assert.equal(signoff.signOff(root, { ...report, plan_hash: 'x' }, config).code, 'plan_changed');
  assert.ok(signoff.signOff(root, report, config).ok);
  assert.ok(signoff.gate(root, live, config, { live: true }).ok);
  const renamed = { ...config, equipment: config.equipment.map((e) => ({ ...e, id: `x_${e.id}`, points: Object.fromEntries(Object.entries(e.points).map(([r, b]) => [r, { ...b, uuid: '11111111-1111-4111-8111-111111111111' }])) })) };
  assert.equal(signoff.planHash(renamed), signoff.planHash(config), 'ids and uuids are outside the fingerprint');
  const changed = { ...config, plan: { ...config.plan, steps: config.plan.steps.slice(1) } };
  assert.equal(signoff.gate(root, live, changed, { live: true }).code, 'sim_signoff_required');
});

test('evidence checks: recirc and max cooling', () => {
  const rows = [0, 1, 2].map((i) => ({ t: i * 60000, v: { 'a:return_air_temperature': 22.5, 'a:mixed_air_temperature': 22.7, 'a:discharge_air_temperature': 23.3, 'a:outdoor_air_intake_damper_position': 0 } }));
  const rc = E.recircChecks(rows, 'a');
  assert.deepEqual(rc.map((c) => c.status), ['pass', 'pass', 'pass']);
  const bad = E.recircChecks(rows.map((r) => ({ ...r, v: { ...r.v, 'a:mixed_air_temperature': 18 } })), 'a');
  assert.equal(bad[1].status, 'fail');
  const mrows = [{ t: 0, v: { 'a:discharge_air_static_pressure': 172, 'a:discharge_air_static_pressure_setpoint': 175, 'a:supply_fan_speed_feedback': 87, 'b1:discharge_air_volume_flow_rate': 480, 'b1:discharge_air_volume_flow_rate_maximum': 500, 'b2:discharge_air_volume_flow_rate': 100, 'b2:discharge_air_volume_flow_rate_maximum': 300 } }];
  const mc = E.maxCoolChecks(mrows, { ahu: 'a', boxes: [{ id: 'b1', strategy: 'airflow_setpoint' }, { id: 'b2', strategy: 'unsupported', ok: false }], curve: { p0: 1000, a: 2.5, designFlowM3s: 0.5, designPressurePa: 750 } });
  assert.deepEqual(mc.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(mc.strategies, { airflow_setpoint: 1, unsupported: 1 });
  assert.equal(mc.operating_point.flow_m3s, 0.48);
  assert.equal(E.verdict(mc.checks), 'pass');
  assert.match(E.trendCsv(mrows, ['a:discharge_air_static_pressure']), /^time_utc,a:discharge_air_static_pressure\n1970-01-01T00:00:00.000Z,172\n$/);
});
