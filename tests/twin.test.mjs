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
const T = require('../static/twin.js');
const vocab = require('../static/roles-223p.js');

const DEMO = fs.readFileSync(path.join(__dirname, 'fixtures', 'rdf', 'hand-223p.ttl'), 'utf8');
const model = S.discover(S.parseTurtle(oxigraph, DEMO), vocab);
const unit = model.ahus[0];
const demoFaults = Object.fromEntries(model.scenarios.map((s) => [s.part, s.spec]));
const sim = (faults = {}) => {
  const s = T.createSim(unit, { points: S.points, faults });
  s.settle();
  return s;
};
const autoValues = (s) => Object.fromEntries(s.inputs.map((p) => [p.id, s.auto(p.id)]));
const currentValues = (s) => Object.fromEntries(s.inputs.map((p) => [p.id, s.get(p.id)]));

test('inputs come from actuatable roles in the model', () => {
  const s = sim();
  const roles = s.inputs.map((p) => p.role).sort();
  assert.ok(roles.includes('supply_fan_speed_command'));
  assert.equal(roles.filter((r) => r === 'damper_position_command').length, 3);
  assert.equal(s.binding.terminals.length, 3);
  assert.deepEqual(s.binding.terminals.map((t) => t.maxLps), [425, 600, 180]);
});

test('the model is deterministic', () => {
  const a = sim().read();
  const b = sim().read();
  assert.deepEqual(a, b);
});

test('physics responds in the right direction', () => {
  const s = sim();
  const speed = s.inputs.find((p) => p.role === 'supply_fan_speed_command').id;
  const before = s.read().scene;
  s.set(speed, 100);
  s.settle(60);
  const fast = s.read().scene;
  assert.ok(fast.staticPa > before.staticPa);
  assert.ok(fast.totalLps > before.totalLps);
  const d1 = s.binding.terminals[0].cmd.id;
  s.set(d1, 100);
  s.settle(120);
  const open = s.read().scene;
  assert.ok(open.terminals[0].flowLps > fast.terminals[0].flowLps, 'opening a damper raises its flow');
  assert.ok(open.staticPa < fast.staticPa, 'and drops duct static');
  const fan = s.inputs.find((p) => p.role === 'supply_fan_command').id;
  s.set(fan, 0);
  s.settle(5);
  assert.equal(s.read().scene.totalLps, 0);
  assert.throws(() => s.set('not_a_point', 1), /not a simulated input/);
});

test('stroke plan is generated per terminal from the model', () => {
  const s = sim();
  const plan = T.strokePlan(s);
  assert.deepEqual(plan.groups.map((g) => g.label), ['VAV-01 Office', 'VAV-02 Conference', 'VAV-03 Corridor']);
  assert.deepEqual(plan.groups[0].steps.map((x) => x.target), [0, 100, 50]);
  assert.deepEqual(plan.skipped, []);
});

test('healthy system passes and releases everything', () => {
  const s = sim();
  const before = currentValues(s);
  const r = T.runStroke(s, T.strokePlan(s));
  assert.equal(r.outcome, 'pass');
  assert.equal(r.results.length, 9);
  assert.ok(r.results.every((x) => x.pass));
  assert.equal(r.release.ok, true);
  assert.deepEqual(currentValues(s), before);
  assert.equal(r.nf_writes, 0);
  assert.equal(r.frames.at(-1).phase, 'IDLE');
  assert.deepEqual(r.frames.at(-1).overrides, []);
});

test('demo scenario: VAV-03 commanded 100% sticks at 38% and fails as actuator binding', () => {
  const s = sim(demoFaults);
  const r = T.runStroke(s, T.strokePlan(s));
  assert.equal(r.outcome, 'fail');
  const bad = r.results.filter((x) => !x.pass);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].label, 'VAV-03 Corridor');
  assert.equal(bad[0].target, 100);
  assert.equal(bad[0].feedback, 38);
  assert.equal(bad[0].timed_out, true);
  assert.equal(bad[0].cause, 'actuator_binding');
  assert.match(bad[0].explanation.join(' '), /binding/);
  assert.equal(r.release.ok, true);
  assert.deepEqual(currentValues(s), autoValues(s));
  const during = r.frames.filter((f) => f.step && f.step.terminal === 'vav_03' && f.phase !== 'RELEASE');
  assert.ok(during.length > 100);
  assert.ok(during.every((f) => f.overrides.includes('vav_03_dmp_cmd')));
  assert.deepEqual(r.frames.at(-1).overrides, []);
});

test('feedback scaling and linkage slip get their own diagnosis', () => {
  const scale = T.runStroke(sim({ vav_02_damper: 'feedback_scale:0.6' }), T.strokePlan(sim()));
  assert.equal(scale.results.find((x) => !x.pass).cause, 'feedback_scaling');
  const link = T.runStroke(sim({ vav_01_damper: 'linkage:20' }), T.strokePlan(sim()));
  assert.equal(link.results.find((x) => !x.pass).cause, 'linkage');
});

test('every way out releases every override', () => {
  const cases = [
    ['operator abort', { abortAtS: 100 }, {}, 'aborted'],
    ['run timeout', { maxRunS: 80 }, {}, 'fail'],
    ['interlock', {}, { staticLimitPa: 320 }, 'fail'],
  ];
  for (const [name, runOpts, planOpts, outcome] of cases) {
    const s = sim();
    const r = T.runStroke(s, T.strokePlan(s, planOpts), runOpts);
    assert.equal(r.outcome, outcome, name);
    assert.ok(r.stop_reason, name);
    assert.ok(r.release.released_at_end.length > 0, `${name} had an override to release`);
    assert.equal(r.release.ok, true, name);
    assert.deepEqual(currentValues(s), autoValues(s), name);
    assert.deepEqual(r.frames.at(-1).overrides, [], name);
  }
});

test('precheck stops before any override', () => {
  const s = sim();
  s.set(s.inputs.find((p) => p.role === 'supply_fan_command').id, 0);
  s.settle(10);
  const r = T.runStroke(s, T.strokePlan(s));
  assert.equal(r.outcome, 'aborted');
  assert.match(r.stop_reason, /precheck/);
  assert.ok(r.frames.every((f) => f.overrides.length === 0));
});

test('a terminal without feedback is skipped, not faked', () => {
  const noFeedback = DEMO.split(/(?<=\s\.)\n/).filter((x) => !x.includes('vav_02_dmp_pos')).join('\n');
  const m = S.discover(S.parseTurtle(oxigraph, noFeedback), vocab);
  const s = T.createSim(m.ahus[0], { points: S.points });
  s.settle();
  const plan = T.strokePlan(s);
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(plan.skipped.map((x) => x.terminal), ['vav_02']);
});

test('diagnose and fault parsing are plain rules', () => {
  assert.deepEqual(T.parseFault('stuck:38'), { kind: 'stuck', value: 38 });
  assert.equal(T.parseFault('melted:1'), null);
  const base = { target: 100, tolerance: 5, flowTolerance: 0.2, reached: false, moved: false };
  assert.equal(T.diagnose({ ...base, feedback: 99, flow: null, expectedAtCommand: null, expectedAtFeedback: null }).pass, true);
  const stuck = T.diagnose({ ...base, feedback: 0, flow: null, expectedAtCommand: null, expectedAtFeedback: null });
  assert.equal(stuck.cause, 'actuator_binding');
  assert.match(stuck.explanation.join(' '), /did not move/);
  assert.equal(T.diagnose({ ...base, feedback: 50, flow: 500, expectedAtCommand: 100, expectedAtFeedback: 40 }).cause, 'inconsistent');
});

test('scene layout is built from the model: parts in air-path order, one branch per terminal', () => {
  const L = T.layout(unit, S.points);
  const onPath = L.elements.filter((e) => e.pos[1] === 0).sort((a, b) => a.pos[0] - b.pos[0]);
  assert.deepEqual([...new Set(onPath.map((e) => e.kind))], ['damper', 'junction', 'filter', 'cooling_coil', 'heating_coil', 'fan']);
  const valves = L.elements.filter((e) => e.kind === 'valve');
  assert.deepEqual(valves.map((v) => v.host).sort(), ['clg_coil', 'htg_coil']);
  assert.equal(L.elements.find((e) => e.id === 'clg_coil').command, 'clg_valve_cmd', 'a coil glows with its valve');
  assert.deepEqual(L.terminals.map((t) => t.label), ['VAV-01 Office', 'VAV-02 Conference', 'VAV-03 Corridor']);
  assert.equal(L.ducts.filter((d) => d.id.startsWith('branch_')).length, 3);
  assert.equal(L.intakes.length, 2);
  assert.equal(L.pointPart.vav_03_dmp_cmd, 'vav_03_damper');
  assert.ok(L.terminals.every((t, i, all) => i === 0 || t.tap[0] > all[i - 1].tap[0]));
  // A smaller model lays out smaller, with nothing hard-coded.
  const one = S.discover(S.parseTurtle(oxigraph, DEMO.split(/(?<=\s\.)\n/).filter((x) => !/vav_0[23]|space_0[23]|zone_0[23]/.test(x)).join('\n')), vocab);
  assert.equal(T.layout(one.ahus[0], S.points).terminals.length, 1);
});

test('static pressure colours ramp from teal through green and amber to red', () => {
  const [low, mid, high, over] = [0, 300, 600, 900].map((pa) => T.pressureColor(pa, 750));
  assert.ok(low[2] > low[0]);
  assert.ok(mid[1] > mid[0] && mid[1] > mid[2]);
  assert.ok(high[0] > high[2]);
  assert.deepEqual(over, [0.93, 0.3, 0.27]);
  assert.deepEqual(T.pressureColor(5000, 0), [0.93, 0.3, 0.27]);
});

test('a model without a fan or feedback still simulates with defaults', () => {
  const bare = DEMO.split(/(?<=\s\.)\n/).filter((x) => !/bldg:sf_|bldg:oa_damper_cmd|bldg:ra_damper_cmd/.test(x)).join('\n');
  const m = S.discover(S.parseTurtle(oxigraph, bare), vocab);
  const s = T.createSim(m.ahus[0], { points: S.points });
  const r = s.settle(30);
  assert.ok(r.scene.staticPa > 0);
  assert.equal(s.auto('nope'), undefined);
});
