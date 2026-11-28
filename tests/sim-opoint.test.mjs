import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sim = require('../hooks/lib/sim.js');
const opoint = require('../hooks/lib/sim_opoint.js');

const cat = sim.catalog();
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('the bench adds two chilled water pumps and operating point points, all prefixed nfft-sim', () => {
  const ids = cat.equipment.map((e) => e.id);
  assert.ok(ids.includes('nfft-sim-chw-pump-1') && ids.includes('nfft-sim-chw-pump-2'));
  const extra = cat.points.filter((p) => opoint.EXTRA_POINTS.some((x) => x.sourceId === p.sourceId));
  assert.equal(extra.length, opoint.EXTRA_POINTS.length);
  for (const p of extra) {
    assert.ok(p.name.startsWith('nfft-sim.'), p.name);
    assert.ok(cat.equipment.some((e) => e.id === p.equipRef), `${p.sourceId} has equipment`);
  }
  assert.equal(new Set(cat.points.map((p) => p.name)).size, cat.points.length, 'names are unique');
});

test('a catalog built from a fixture alone gets none of the extras', () => {
  const plain = sim.catalog({ model: [{ pointType: 'EQUIPMENT', attrs: { id: 'ahu-1', markers: 'equip,ahu' } }], points: [] });
  assert.equal(plain.equipment.length, 1);
  assert.equal(plain.points.length, 0);
  assert.equal(plain.equipment[0].extra, undefined);
});

test('nameplate attributes reach the equipment records; the incomplete pump has none', () => {
  const rows = sim.tagPayload(cat, {}, { patch: cat.points.map((p) => ({ name: p.name })), create: [] }, []);
  const attrs = (id) => rows.find((r) => r.attrs && r.attrs.id === id).attrs;
  assert.equal(attrs('nfft-sim-chw-pump-1').designFlow, '16 L/s');
  assert.equal(attrs('nfft-sim-ahu-1').designPressure, '500 Pa');
  assert.equal(attrs('nfft-sim-chw-pump-2').designFlow, undefined);
  assert.equal(attrs('nfft-sim-ahu-2').designFlow, undefined);
  assert.ok(rows.filter((r) => r.pointType === 'EQUIPMENT').every((r) => r.layer === 'model'));
});

test('the deliberately incomplete pump has only a setpoint, power and run point', () => {
  const mine = cat.points.filter((p) => p.equipRef === 'nfft-sim-chw-pump-2').map((p) => p.sourceId.split('.')[1]).sort();
  assert.deepEqual(mine, ['dp-sp', 'kw', 'run']);
});

test('pump and fan readings follow valve demand and fan speed', () => {
  const v = sim.initialValues(cat);
  near(v['ahu-1.dsp-sp'], 120, 0);
  assert.ok(v['chw-pump-1.speed'] >= 50 && v['chw-pump-1.speed'] <= 100);
  near(v['chw-pump-1.flow'], 16 * (v['chw-pump-1.speed'] / 100) * 0.9, 0.01);
  near(v['chw-pump-1.kw'], 4.5 * (v['chw-pump-1.speed'] / 100) ** 3, 0.01);
  assert.equal(v['chw-pump-2.kw'], 0);
  // More cooling demand: faster pump, more flow, more power.
  const hot = { ...v, 'ahu-1.clg-vlv': 100, 'ahu-2.clg-vlv': 100 };
  const next = sim.stepPhysics(hot);
  assert.ok(next['chw-pump-1.speed'] > v['chw-pump-1.speed']);
  assert.ok(next['chw-pump-1.flow'] > v['chw-pump-1.flow']);
  assert.ok(next['chw-pump-1.kw'] > v['chw-pump-1.kw']);
  near(next['chw-pump-1.speed'], 100, 0.01);
  // A stopped pump reads zero.
  const off = sim.stepPhysics({ ...v, 'chw-pump-1.run': 0 });
  assert.equal(off['chw-pump-1.speed'], 0);
  assert.equal(off['chw-pump-1.kw'], 0);
  // Fan: feedback and airflow follow the speed command; power follows the cube.
  const slow = sim.stepPhysics({ ...v, 'ahu-1.sf-speed': 50 });
  assert.equal(slow['ahu-1.sf-speed-fb'], 50);
  near(slow['ahu-1.sf-kw'], 4 * 0.125, 0.01);
  assert.ok(slow['ahu-1.flow'] < v['ahu-1.flow']);
  const stopped = sim.stepPhysics({ ...v, 'ahu-1.sf-status': 0 });
  assert.equal(stopped['ahu-1.sf-speed-fb'], 0);
});

test('a fixture without the extra points is stepped exactly as before', () => {
  const next = sim.stepPhysics({ 'ahu-1.sf-speed': 70, 'ahu-1.sf-status': 1 });
  assert.equal(Object.keys(next).some((k) => /chw-pump|sf-kw|sf-speed-fb/.test(k)), false);
});

test('BACnet units cover kPa and kW', () => {
  assert.equal(sim.bacnetUnits('kPa'), 54);
  assert.equal(sim.bacnetUnits('kW'), 48);
});