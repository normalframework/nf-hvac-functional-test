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
const T = require('../static/graphic.js');
const vocab = require('../static/roles-223p.js');
const SG = require('../static/schematic.js');

const TTL = fs.readFileSync(path.join(__dirname, 'fixtures', 'rdf', 'hand-223p.ttl'), 'utf8');
const model = S.discover(S.parseTurtle(oxigraph, TTL), vocab);

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function assertNoOverlap(lay, what) {
  const boxes = [
    ...Object.values(lay.slots).filter((s) => !s.host).map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.w, h: s.h })),
    ...lay.terminals.map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h })),
  ];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!overlap(boxes[i], boxes[j]), `${what}: ${boxes[i].id} overlaps ${boxes[j].id}`);
    assert.ok(boxes[i].x >= 0 && boxes[i].x + boxes[i].w <= lay.width && boxes[i].y >= 0 && boxes[i].y + boxes[i].h <= lay.height, `${what}: ${boxes[i].id} is inside the drawing`);
  }
  const valves = Object.values(lay.slots).filter((s) => s.host);
  for (let i = 0; i < valves.length; i += 1) for (let j = i + 1; j < valves.length; j += 1) assert.ok(!overlap(valves[i], valves[j]), `${what}: valve slots overlap`);
}

test('truncate keeps the full text for the tooltip', () => {
  assert.deepEqual(SG.truncate('AHU-1', 10), { text: 'AHU-1', full: 'AHU-1', truncated: false });
  const t = SG.truncate('Breakroom zone temperature', 12);
  assert.equal(t.text.length, 12);
  assert.ok(t.text.endsWith('…'));
  assert.equal(t.full, 'Breakroom zone temperature');
  assert.equal(t.truncated, true);
  assert.equal(SG.truncate(null, 5).text, '');
});

test('wrapLabel wraps at word boundaries, never exceeds the width, and ends with an ellipsis when cut', () => {
  assert.deepEqual(SG.wrapLabel('VAV-2B Breakroom', 11), ['VAV-2B', 'Breakroom']);
  assert.deepEqual(SG.wrapLabel('AHU-1', 11), ['AHU-1']);
  assert.deepEqual(SG.wrapLabel('', 11), []);
  const long = SG.wrapLabel('Supercalifragilisticexpialidocious pump', 12, 2);
  assert.equal(long.length, 2);
  assert.ok(long.every((l) => l.length <= 12), JSON.stringify(long));
  assert.ok(long[1].endsWith('…'));
  const three = SG.wrapLabel('one two three four five six seven', 8, 3);
  assert.equal(three.length, 3);
  assert.ok(three.every((l) => l.length <= 8));
});

test('slots have a fixed pitch and a grid wraps by row', () => {
  assert.equal(SG.slotX(10, 100, 3), 310);
  assert.deepEqual(SG.gridCell(7, 6), { col: 1, row: 1 });
  assert.deepEqual(SG.gridCell(5, 6), { col: 5, row: 0 });
});

test('2D layout of the demo unit: parts in air-path order, one slot per terminal, nothing overlapping', () => {
  const unit = model.ahus[0];
  const L = T.layout(unit, S.points, model);
  const lay = SG.layout2d(L);
  const order = ['oa_damper', 'mixing', 'filter', 'clg_coil', 'htg_coil', 'supply_fan'];
  const xs = order.map((id) => lay.slots[id].x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'left to right in air-path order');
  assert.ok(lay.slots.oa_damper.y < lay.slots.ra_damper.y, 'parallel dampers are stacked in lanes');
  assert.equal(lay.slots.oa_damper.x, lay.slots.ra_damper.x);
  assert.equal(lay.terminals.length, unit.terminals.length);
  assert.ok(lay.slots.clg_valve.host === 'clg_coil' && lay.slots.clg_valve.x > lay.slots.clg_coil.x);
  assertNoOverlap(lay, 'demo');
});

function synthetic(nTerm, nPlants) {
  const elements = [];
  ['oa_damper', 'ra_damper'].forEach((id, i) => elements.push({ id, kind: 'damper', label: `Damper ${id}`, scope: 'ahu', pos: [0, 0, i ? 0.75 : -0.75], size: [1, 1, 1], command: `${id}_cmd` }));
  ['filter', 'clg_coil', 'htg_coil', 'supply_fan', 'return_fan'].forEach((id, i) => elements.push({ id, kind: id.replace(/_.*/, ''), label: `A rather long component name number ${i}`, scope: 'ahu', pos: [(i + 1) * 1.9, 0, 0], size: [1, 1, 1] }));
  elements.push({ id: 'v1', kind: 'valve', label: 'Cooling valve', scope: 'ahu', pos: [3.8, 1.25, 0], size: [1, 1, 1], host: 'clg_coil', command: 'v1c' });
  elements.push({ id: 'v2', kind: 'valve', label: 'Heating valve', scope: 'ahu', pos: [3.8, 1.25, 0], size: [1, 1, 1], host: 'clg_coil', command: 'v2c' });
  for (let i = 0; i < nPlants; i += 1) elements.push({ id: `pl${i}`, kind: i % 2 ? 'pump' : 'boiler', label: `Plant equipment with a very long name ${i}`, scope: 'plant', pos: [i, 0, 0], size: [1, 1, 1] });
  const terminals = Array.from({ length: nTerm }, (_, i) => ({ id: `t${i}`, index: i, label: `VAV-${i} Open office northwest corner zone`, zone: { id: `z${i}`, label: 'A zone with a long name' }, damper: `d${i}`, reheat: null, valve: null }));
  return { casing: { id: 'ahu', label: 'AHU with a very long descriptive name', from: [0, 0, 0], to: [1, 1, 1] }, elements, terminals, pipes: [], plants: [] };
}

test('2D layout holds for many terminals, many plants and long names', () => {
  for (const [nt, np] of [[0, 0], [1, 0], [6, 2], [7, 3], [25, 5]]) {
    const lay = SG.layout2d(synthetic(nt, np));
    assertNoOverlap(lay, `${nt} terminals, ${np} plants`);
    assert.equal(lay.terminals.length, nt);
    assert.equal(lay.buses.length, nt ? Math.ceil(nt / Math.min(6, nt)) : 0);
  }
});

test('pipes run plant to bus to coil along fixed lanes', () => {
  const L = synthetic(2, 2);
  const lay = SG.layout2d(L);
  const hw = SG.pipePath(lay, 'pl0', 'clg_coil', 'hot_water');
  const chw = SG.pipePath(lay, 'pl0', 'clg_coil', 'chilled_water');
  assert.equal(hw.length, 4);
  assert.equal(hw[1][1], lay.busHw);
  assert.equal(chw[1][1], lay.busChw);
  assert.notEqual(lay.busHw, lay.busChw);
  assert.equal(hw[3][1], lay.slots.clg_coil.y, 'ends on the coil top edge');
  assert.equal(SG.pipePath(lay, 'nope', 'clg_coil', 'hot_water'), null);
});
test('live values unwrap NF latestValue objects, so the live graphic shows numbers instead of dashes', () => {
  const unit = model.ahus[0];
  const pts = S.points(unit);
  const fan = pts.find((p) => p.role === 'supply_fan_speed_command');
  const dsp = pts.find((p) => p.role === 'discharge_air_static_pressure');
  assert.equal(T.unwrap({ value: { ts: 'x', double: 62 }, ts: 'x' }), 62);
  assert.equal(T.unwrap(7), 7);
  assert.equal(T.unwrap({ boolean: true }), true);
  const frame = T.liveFrame(unit, S.points, { [fan.id]: { value: { ts: 'x', double: 62 }, ts: 'x' }, [dsp.id]: { value: { ts: 'x', double: 180.5 }, ts: 'x' } });
  assert.equal(frame.scene.fanSpeed, 62);
  assert.equal(frame.scene.staticPa, 180.5);
  assert.equal(frame.scene.staticKnown, true);
});
