import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../static/oppoint-math.js');

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test('units convert to SI base: L/s, kPa and kW in, m3/s, Pa and W out', () => {
  near(M.toSI('flow', '16 L/s', 'L/s'), 0.016);
  near(M.toSI('flow', 16, 'L/s'), 0.016);
  near(M.toSI('flow', '250 gpm', 'L/s'), 250 * 6.30901964e-5);
  near(M.toSI('flow', '1000 cfm', 'L/s'), 1000 * 4.71947443e-4);
  near(M.toSI('pressure', '180 kPa', 'Pa'), 180000);
  near(M.toSI('pressure', 250, 'Pa'), 250);
  near(M.toSI('pressure', '2 in H2O', 'Pa'), 2 * 249.08891);
  near(M.toSI('power', '4.5 kW', 'W'), 4500);
  assert.equal(M.toSI('flow', 'fast', 'L/s'), null);
  assert.equal(M.toSI('flow', '5 furlongs', 'L/s'), null);
  assert.equal(M.toSI('flow', null, 'L/s'), null);
});

test('imperial is display only', () => {
  near(M.imperial.waterFlow(0.016).value, 253.6, 1e-3);
  assert.equal(M.imperial.waterFlow(0.016).unit, 'gpm');
  near(M.imperial.waterHead(180000).value, 60.2, 1e-2);
  assert.equal(M.imperial.airFlow(1).unit, 'cfm');
  assert.equal(M.display.flow(0.016).unit, 'L/s');
  assert.equal(M.display.pressure(180000).unit, 'kPa');
  assert.equal(M.display.pressure(250).unit, 'Pa');
});

test('speed readings become a fraction of rated speed', () => {
  near(M.speedFraction(42, 'Hz', 60), 0.7);
  near(M.speedFraction(70, '%'), 0.7);
  near(M.speedFraction(0.7, ''), 0.7);
  near(M.speedFraction(70, ''), 0.7);
  near(M.speedFraction(1050, 'rpm', 60, 1500), 0.7);
  assert.equal(M.speedFraction(1050, 'rpm'), null);
  assert.equal(M.speedFraction(null, '%'), null);
});

test('affinity laws: flow ~ s, head ~ s^2, power ~ s^3', () => {
  near(M.affinity.flow(10, 0.5), 5);
  near(M.affinity.head(100, 0.5), 25);
  near(M.affinity.power(8, 0.5), 1);
  const c = M.makeCurve({ designFlow: 0.02, designHead: 150000 });
  // The curve at speed s is the 100 percent curve scaled homologously.
  const q = 0.012;
  near(c.head(q, 0.6), 0.36 * c.head(q / 0.6, 1));
  near(c.power(q, 0.6), 0.216 * c.power(q / 0.6, 1));
});

test('a nameplate curve passes through the design point and is generic in shape', () => {
  const c = M.makeCurve({ designFlow: 0.02, designHead: 150000, designPower: 4000 });
  assert.equal(c.source, 'nameplate');
  assert.equal(c.illustrative, false);
  near(c.head(0.02, 1), 150000);
  assert.ok(c.head(0, 1) > c.head(0.02, 1), 'head falls with flow');
  near(c.head(0, 1), 1.25 * 150000);
  near(c.head(c.maxFlow, 1), 0, 1e-9);
  assert.equal(c.head(0.01, 0), 0);
});

test('polynomial coefficients define the curve and override the generic shape', () => {
  // H [Pa] = 200000 - 1.5e8 Q^2  (Q in m3/s)
  const c = M.makeCurve({ designFlow: 0.02, coeffs: [200000, 0, -1.5e8] });
  assert.equal(c.source, 'coefficients');
  near(c.head(0, 1), 200000);
  near(c.head(0.02, 1), 200000 - 1.5e8 * 0.0004);
  near(c.designHead, c.head(0.02, 1));
  near(c.head(0.01, 0.5), 0.25 * c.head(0.02, 1));
  assert.ok(c.maxFlow > 0.02 && Math.abs(c.head(c.maxFlow, 1)) < 1);
});

test('no nameplate gives a normalized, illustrative generic curve', () => {
  const c = M.makeCurve({});
  assert.equal(c.source, 'generic');
  assert.equal(c.illustrative, true);
  assert.equal(c.normalized, true);
  near(c.head(1, 1), 1);
  const fan = M.makeCurve({ kind: 'fan' });
  near(fan.head(0, 1), 1.3);
  // Only a flow or only a head is not enough.
  assert.equal(M.makeCurve({ designFlow: 0.02 }).normalized, true);
  assert.equal(M.makeCurve({ designHead: 1000 }).normalized, true);
});

test('system curve H = Hs + k Q^2 is fitted from the setpoint and the current point', () => {
  const sys = M.fitSystem({ hStatic: 80000, q: 0.01, h: 100000 });
  near(sys.hStatic, 80000);
  near(sys.k, 20000 / 1e-4);
  assert.equal(sys.adjusted, false);
  near(M.systemHead(sys, 0.01), 100000);
  near(M.systemHead(sys, 0), 80000);
  // A setpoint above what the pump delivers is limited to 90 percent of the head.
  const lim = M.fitSystem({ hStatic: 120000, q: 0.01, h: 100000 });
  assert.equal(lim.adjusted, true);
  near(lim.hStatic, 90000);
  assert.ok(lim.k > 0);
});

test('operating point is the intersection of the curve at speed and the system curve', () => {
  const c = M.makeCurve({ designFlow: 0.02, designHead: 150000 });
  const sys = M.fitSystem({ hStatic: 80000, q: 0.02, h: 150000 });
  const full = M.intersect(c, 1, sys);
  near(full.q, 0.02, 1e-6);
  near(full.h, 150000, 1e-6);
  const slow = M.intersect(c, 0.8, sys);
  assert.ok(slow.q < full.q && slow.h < full.h);
  near(slow.h, M.systemHead(sys, slow.q), 1e-6);
  near(slow.h, c.head(slow.q, 0.8), 1e-6);
  // Too slow to lift the static head: no intersection.
  assert.equal(M.intersect(c, 0.5, sys), null);
  assert.equal(M.intersect(c, 0, sys), null);
});

test('fixed speed against variable speed at the same flow', () => {
  const c = M.makeCurve({ designFlow: 0.02, designHead: 150000 });
  const sys = M.fitSystem({ hStatic: 80000, q: 0.02, h: 150000 });
  const op = M.intersect(c, 0.9, sys);
  const cmp = M.compareFixedSpeed(c, sys, { q: op.q, h: op.h, s: 0.9 });
  const [vfd, thr, nat] = cmp.rows;
  assert.equal(vfd.id, 'vfd');
  assert.equal(thr.id, 'throttled');
  assert.equal(nat.id, 'natural');
  near(thr.q, vfd.q);
  assert.ok(thr.h > vfd.h, 'throttled fixed speed runs at a higher head');
  assert.ok(thr.powerW > vfd.powerW, 'and draws more power');
  assert.ok(nat.q > vfd.q, 'wide open it moves more flow');
  near(cmp.savedW, thr.powerW - vfd.powerW);
  near(cmp.throttleHead, thr.h - vfd.h);
  // A measured kW anchors the model.
  const anchored = M.compareFixedSpeed(c, sys, { q: op.q, h: op.h, s: 0.9, powerW: 1000 });
  near(anchored.rows[0].powerW, 1000);
  near(anchored.rows[1].powerW / anchored.rows[0].powerW, thr.powerW / vfd.powerW);
});

test('chart samples stay inside the requested flow range', () => {
  const c = M.makeCurve({ designFlow: 0.02, designHead: 150000 });
  const pts = M.sampleCurve(c, 1, 10, 0.03);
  assert.equal(pts.length, 11);
  near(pts[10][0], 0.03);
  const sys = M.sampleSystem({ hStatic: 1, k: 2 }, 3, 3);
  assert.deepEqual(sys, [[0, 1], [1, 3], [2, 9], [3, 19]]);
});