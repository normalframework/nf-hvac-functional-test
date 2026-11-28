import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../static/oppoint-model.js');
const vocab = require('../static/roles-223p.js');
const bind = require('../static/haystack-bind.js');
const sim = require('../hooks/lib/sim.js');
const deps = { vocab, bind };

let n = 0;
const equip = (id, markers, attrs = {}) => ({ uuid: `e-${id}`, name: id, pointType: 'EQUIPMENT', attrs: { id, dis: id.toUpperCase(), markers, ...attrs } });
const point = (equipRef, id, markers, unit = '') => { n += 1; return { uuid: `p-${n}`, name: id, attrs: { id, dis: id, markers, equipRef, unit } }; };

/** A compact site: one chilled water pump with a full tag set, one with nothing, two AHUs, three VAVs. */
function site() {
  const pointRows = [
    point('chw-p1', 'p1.speed', 'point,pump,speed,sensor', '%'),
    point('chw-p1', 'p1.flow', 'point,chilled,water,flow,sensor', 'L/s'),
    point('chw-p1', 'p1.dp', 'point,chilled,water,delta,pressure,sensor', 'kPa'),
    point('chw-p1', 'p1.dpsp', 'point,chilled,water,delta,pressure,sp', 'kPa'),
    point('chw-p1', 'p1.kw', 'point,pump,elec,power,sensor', 'kW'),
    point('ahu-1', 'a1.cv', 'point,cool,valve,sensor', '%'),
    point('ahu-2', 'a2.cvc', 'point,cool,valve,cmd', '%'),
    point('ahu-1', 'a1.fan', 'point,discharge,fan,vfd,speed,cmd', '%'),
    point('ahu-1', 'a1.static', 'point,discharge,air,pressure,sensor', 'Pa'),
    point('vav-1', 'v1.dmp', 'point,damper,sensor', '%'),
    point('vav-1', 'v1.flow', 'point,discharge,air,flow,sensor', 'L/s'),
    point('vav-2', 'v2.dmpc', 'point,damper,cmd', '%'),
    point('vav-2', 'v2.out', 'point,outside,damper,sensor', '%'),
  ];
  return {
    model: [
      { uuid: 's', name: 'site', pointType: 'SITE', attrs: { id: 'site', markers: 'site' } },
      equip('chw-p1', 'equip,pump,chilled,water', { designFlow: '16 L/s', designHead: '180 kPa' }),
      equip('chw-p2', 'equip,pump,chilled,water'),
      equip('hw-p1', 'equip,pump,hot,water', { feeds: 'ahu-1' }),
      equip('cw-p1', 'equip,pump,condenser,water'),
      equip('ahu-1', 'equip,ahu'),
      equip('ahu-2', 'equip,ahu'),
      equip('vav-1', 'equip,vav,airTerminalUnit', { airRef: 'ahu-1' }),
      equip('vav-2', 'equip,vav,airTerminalUnit', { airRef: 'AHU-1' }),
      equip('vav-3', 'equip,vav,airTerminalUnit', { airRef: 'ahu-2' }),
    ],
    points: pointRows,
  };
}

const byId = (list, id) => list.find((e) => e.id === id);

test('pumps and air handlers come from equipment markers; condenser pumps are out of scope', () => {
  const r = Model.resolve(site(), deps);
  assert.deepEqual(r.pumps.map((p) => p.id), ['chw-p1', 'chw-p2', 'hw-p1']);
  assert.deepEqual(r.pumps.map((p) => p.medium), ['chw', 'chw', 'hw']);
  assert.deepEqual(r.fans.map((f) => f.id), ['ahu-1', 'ahu-2']);
});

test('roles resolve by 223P role when the vocabulary has one, else by marker set', () => {
  const r = Model.resolve(site(), deps);
  const p1 = byId(r.pumps, 'chw-p1');
  assert.equal(p1.q.flow.point.id, 'p1.flow');
  assert.match(p1.q.flow.via, /^role chilled_water_volume_flow_rate/);
  assert.match(p1.q.dp.via, /^role chilled_water_pressure_delta/);
  assert.match(p1.q.dpSp.via, /^role chilled_water_pressure_delta_setpoint/);
  // The pinned vocabulary has no pump speed role: the marker set resolves it.
  assert.equal(p1.q.speed.point.id, 'p1.speed');
  assert.match(p1.q.speed.via, /^tags pump speed sensor/);
  assert.equal(p1.q.power.point.id, 'p1.kw');
  // Without a vocabulary the marker sets still resolve everything.
  const bare = Model.resolve(site(), {});
  assert.equal(byId(bare.pumps, 'chw-p1').q.flow.point.id, 'p1.flow');
  assert.deepEqual(byId(bare.pumps, 'chw-p1').missing, []);
});

test('a complete pump has nothing missing; the loop members and their valves come from the model', () => {
  const r = Model.resolve(site(), deps);
  const p1 = byId(r.pumps, 'chw-p1');
  assert.deepEqual(p1.missing, []);
  assert.equal(Model.missingText(p1), '');
  assert.deepEqual(p1.branches.map((b) => [b.id, b.valve && b.valve.point.id]), [['ahu-1', 'a1.cv'], ['ahu-2', 'a2.cvc']]);
  // A cooling valve command is accepted when there is no position sensor.
  assert.match(p1.branches[1].valve.via, /cool valve cmd|role cooling_valve_position_command/);
});

test('missing tags are listed by their exact Haystack tags', () => {
  const r = Model.resolve(site(), deps);
  const p2 = byId(r.pumps, 'chw-p2');
  assert.deepEqual(p2.missing, [
    'pump speed sensor',
    'chilled water flow sensor',
    'chilled water delta pressure sensor',
    'chilled water delta pressure sp',
    'pump elec power sensor',
  ]);
  assert.equal(Model.missingText(p2), 'Missing data: pump speed sensor, chilled water flow sensor, chilled water delta pressure sensor, chilled water delta pressure sp, pump elec power sensor');
  const a2 = byId(r.fans, 'ahu-2');
  assert.deepEqual(a2.missing, [
    'discharge fan vfd speed sensor',
    'discharge air pressure sensor',
    'discharge air pressure sp',
    'discharge air flow sensor',
    'discharge fan elec power sensor',
    'damper sensor (VAV)',
  ]);
  // The optional run sensor is never reported.
  assert.ok(!a2.missing.some((m) => /run/.test(m)));
});

test('hot water pumps name hot water tags', () => {
  const r = Model.resolve(site(), deps);
  const hw = byId(r.pumps, 'hw-p1');
  assert.ok(hw.missing.includes('hot water flow sensor'));
  assert.ok(hw.missing.includes('hot water delta pressure sp'));
  assert.deepEqual(hw.branches.map((b) => b.id), ['ahu-1']);
  assert.equal(hw.branches[0].valve, null, 'ahu-1 has no heat valve point');
});

test('the DP sensor may sit on plant equipment or a loop AHU, never on another pump', () => {
  const s = site();
  s.model.push(equip('chiller-1', 'equip,chiller'));
  s.points.push(point('chiller-1', 'ch.flow', 'point,chilled,water,flow,sensor', 'L/s'));
  s.points.push(point('ahu-2', 'a2.dp', 'point,chilled,water,delta,pressure,sensor', 'kPa'));
  const r = Model.resolve(s, deps);
  const p2 = byId(r.pumps, 'chw-p2');
  assert.equal(p2.q.flow.point.id, 'ch.flow');
  assert.equal(p2.q.flow.remote, true);
  assert.equal(p2.q.flow.equipId, 'chiller-1');
  assert.equal(p2.q.dp.point.id, 'a2.dp');
  assert.ok(!p2.missing.includes('chilled water flow sensor'));
  const p1 = byId(r.pumps, 'chw-p1');
  assert.equal(p1.q.flow.point.id, 'p1.flow', 'its own point wins');
  assert.equal(p1.q.dp.remote, false);
});

test('fans: VAV dampers use the damper position and never an outside air damper', () => {
  const r = Model.resolve(site(), deps);
  const a1 = byId(r.fans, 'ahu-1');
  assert.deepEqual(a1.terminals.map((t) => [t.id, t.damper.found && t.damper.point.id]), [['vav-1', 'v1.dmp'], ['vav-2', 'v2.dmpc']]);
  assert.equal(a1.q.speed.point.id, 'a1.fan');
  assert.equal(a1.q.static.point.id, 'a1.static');
  // No AHU flow sensor, but a VAV reports flow: the sum stands in, and is not missing.
  assert.equal(a1.q.flow.derived, 'terminals');
  assert.ok(!a1.missing.includes('discharge air flow sensor'));
  assert.deepEqual(a1.missing, ['discharge air pressure sp', 'discharge fan elec power sensor']);
});

test('latest values unwrap NF value objects', () => {
  assert.equal(Model.scalar(42), 42);
  assert.equal(Model.scalar('3.5'), 3.5);
  assert.equal(Model.scalar(true), 1);
  assert.equal(Model.scalar({ value: 7 }), 7);
  assert.equal(Model.scalar({ value: { ts: 'x', double: 12.5 } }), 12.5);
  assert.equal(Model.scalar({ ts: 'x', double: 0 }), 0);
  assert.equal(Model.scalar({ boolean: false }), 0);
  assert.equal(Model.scalar(null), null);
  assert.equal(Model.scalar({ value: null }), null);
  assert.equal(Model.scalar('n/a'), null);
});

function valuesFor(r, map) {
  const out = {};
  const put = (q) => { if (q && q.point && map[q.point.id] !== undefined) out[q.point.uuid] = { value: { ts: 't', double: map[q.point.id] } }; };
  for (const e of [...r.pumps, ...r.fans]) {
    Object.values(e.q).forEach(put);
    (e.terminals || []).forEach((t) => { put(t.damper); put(t.flow); });
    (e.branches || []).forEach((b) => put(b.valve));
  }
  return out;
}

test('a full pump computes a real operating point from measured flow, speed and the DP setpoint', () => {
  const r = Model.resolve(site(), deps);
  const p1 = byId(r.pumps, 'chw-p1');
  const c = Model.compute(p1, valuesFor(r, { 'p1.speed': 70, 'p1.flow': 10, 'p1.dp': 82, 'p1.dpsp': 80, 'p1.kw': 1.5 }));
  assert.equal(c.curveSource, 'nameplate');
  assert.equal(c.illustrative, false);
  assert.ok(Math.abs(c.flow - 0.01) < 1e-12, 'L/s to m3/s');
  assert.ok(Math.abs(c.dpSp - 80000) < 1e-9, 'kPa to Pa');
  assert.ok(Math.abs(c.speed.fraction - 0.7) < 1e-12);
  assert.equal(c.speed.hz, 42);
  assert.equal(c.op.source, 'measured');
  // Head from the curve at 70 percent speed; the system curve passes through the point.
  assert.ok(Math.abs(c.op.h - c.curve.head(0.01, 0.7)) < 1e-6);
  assert.ok(Math.abs(c.sys.hStatic + c.sys.k * 1e-4 - c.op.h) < 1e-6);
  assert.equal(c.sys.hStatic, 80000);
  assert.equal(c.powerSource, 'measured');
  assert.equal(c.powerW, 1500);
  assert.ok(c.cmp.rows.length === 3 && c.cmp.savedW > 0);
});

test('without a flow sensor the point is the intersection of curve and system curve', () => {
  const r = Model.resolve(site(), deps);
  const p1 = byId(r.pumps, 'chw-p1');
  const c = Model.compute(p1, valuesFor(r, { 'p1.speed': 100, 'p1.dpsp': 80 }));
  assert.match(c.op.source, /intersection/);
  assert.ok(Math.abs(c.op.q - 0.016) < 1e-6, 'at full speed the design point lies on the system curve');
  assert.equal(c.powerSource, 'estimated from the curve');
  assert.ok(c.powerW > 0);
});

test('with nothing measured the chart is still drawn: generic, illustrative, normalized', () => {
  const r = Model.resolve(site(), deps);
  const p2 = byId(r.pumps, 'chw-p2');
  const c = Model.compute(p2, {});
  assert.equal(c.illustrative, true);
  assert.equal(c.curve.normalized, true);
  assert.equal(c.curveSource, 'generic');
  assert.ok(c.op && c.op.q > 0 && c.op.h > 0);
  assert.equal(c.flow, null);
  assert.equal(c.powerW, null);
  assert.ok(c.notes.some((x) => /speed unknown/.test(x)));
  assert.ok(c.cmp, 'the fixed speed against variable speed comparison is still shown');
});

test('curve coefficients on the equipment replace the generic shape (kPa and L/s in the attribute)', () => {
  const s = site();
  // H [kPa] = 220 - 0.3 Q^2 with Q in L/s: 100 kPa at 20 L/s... at 16 L/s: 220 - 76.8
  s.model.find((e) => e.attrs.id === 'chw-p1').attrs.curveCoeffs = '220,0,-0.3';
  const r = Model.resolve(s, deps);
  const np = Model.nameplate(byId(r.pumps, 'chw-p1'));
  assert.deepEqual(np.coeffs, [220000, 0, -0.3 * 1000 * 1e6]);
  const c = Model.compute(byId(r.pumps, 'chw-p1'), {});
  assert.equal(c.curveSource, 'coefficients');
  assert.ok(Math.abs(c.curve.head(0.016, 1) - (220 - 0.3 * 256) * 1000) < 1e-6);
});

test('fan nameplate: design pressure in Pa, flow in L/s', () => {
  const s = site();
  Object.assign(s.model.find((e) => e.attrs.id === 'ahu-1').attrs, { designFlow: '1200 L/s', designPressure: '500 Pa', designPower: '4 kW' });
  const r = Model.resolve(s, deps);
  const a1 = byId(r.fans, 'ahu-1');
  const np = Model.nameplate(a1);
  assert.equal(np.designHead, 500);
  assert.equal(np.designFlow, 1.2);
  assert.equal(np.designPower, 4000);
  const c = Model.compute(a1, valuesFor(r, { 'a1.fan': 70, 'a1.static': 120, 'v1.flow': 300 }));
  assert.equal(c.curveSource, 'nameplate');
  assert.match(c.flowSource, /sum of 1 VAV flow sensor/);
  assert.ok(c.notes.some((x) => /only 1 of 2 VAVs report flow/.test(x)));
  assert.ok(c.speed.command);
});

test('the simulated bench: complete panels, plus two deliberately incomplete ones', () => {
  const cat = sim.catalog();
  const rows = sim.tagPayload(cat, {}, { patch: cat.points.map((p) => ({ name: p.name })), create: [] }, []);
  const r = Model.resolve({ model: rows, points: [] }, deps);
  const named = (id) => [...r.pumps, ...r.fans].find((e) => e.id === `nfft-sim-${id}`);
  for (const id of ['chw-pump-1', 'hw-pump-1', 'ahu-1']) assert.deepEqual(named(id).missing, [], id);
  assert.deepEqual(named('chw-pump-2').missing, ['pump speed sensor', 'chilled water flow sensor', 'chilled water delta pressure sensor']);
  assert.deepEqual(named('ahu-2').missing, ['discharge air pressure sp', 'discharge fan elec power sensor']);
  // The loop: the CHW pumps serve both AHUs, the HW pump serves AHU-1 and the VAV reheat valves under it.
  assert.deepEqual(named('chw-pump-1').branches.map((b) => b.id), ['nfft-sim-ahu-1', 'nfft-sim-ahu-2']);
  assert.ok(named('hw-pump-1').reheat.length >= 1);
  // Values from the simulator give a real, non-illustrative panel.
  const uuidOf = Object.fromEntries(rows.filter((x) => x.attrs && x.attrs.id).map((x) => [x.attrs.id, x.uuid]));
  const values = {};
  for (const [k, v] of Object.entries(sim.initialValues(cat))) if (uuidOf[`nfft-sim-${k}`]) values[uuidOf[`nfft-sim-${k}`]] = v;
  const c = Model.compute(named('chw-pump-1'), values);
  assert.equal(c.illustrative, false);
  assert.equal(c.op.source, 'measured');
  assert.ok(c.op.q > 0 && c.sys.k > 0 && !c.sys.adjusted);
  const f = Model.compute(named('ahu-1'), values);
  assert.equal(f.illustrative, false);
  assert.ok(f.op.h > 0 && f.powerSource === 'measured');
  const bad = Model.compute(named('chw-pump-2'), values);
  assert.equal(bad.illustrative, true);
});
