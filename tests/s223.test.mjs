import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const oxigraph = require('../static/vendor/oxigraph/node.js');
const S = require('../static/s223.js');
const vocab = require('../static/roles-223p.js');

const ROOT = path.join(__dirname, '..');
const DEMO = fs.readFileSync(path.join(__dirname, 'fixtures', 'rdf', 'hand-223p.ttl'), 'utf8');

/** Drop every statement that mentions one of the given local names (makes smaller site models). */
function without(text, names) {
  return text
    .split(/(?<=\s\.)\n/)
    .filter((stmt) => !names.some((n) => stmt.includes(n)))
    .join('\n');
}

const discoverText = (text) => S.discover(S.parseTurtle(oxigraph, text), vocab);

test('demo model: one air handler, parts in air-path order, three terminals with zones', () => {
  const m = discoverText(DEMO);
  assert.deepEqual(m.warnings, []);
  assert.equal(m.ahus.length, 1);
  const ahu = m.ahus[0];
  const onPath = ahu.parts.filter((p) => p.layer != null).sort((a, b) => a.layer - b.layer || a.lane - b.lane);
  assert.deepEqual(onPath.map((p) => p.kind), ['damper', 'damper', 'junction', 'filter', 'cooling_coil', 'heating_coil', 'fan']);
  assert.deepEqual(ahu.outlets.map((o) => (typeof o === 'string' ? o : o.id)), ['supply_fan']);
  assert.deepEqual(ahu.terminals.map((t) => t.label), ['VAV-01 Office', 'VAV-02 Conference', 'VAV-03 Corridor']);
  assert.deepEqual(ahu.terminals.map((t) => t.zone.label), ['Office', 'Conference', 'Corridor']);
  assert.ok(ahu.terminals.every((t) => t.zone.zone && /zone$/.test(t.zone.zone.label)));
  const valves = ahu.parts.filter((p) => p.kind === 'valve');
  assert.deepEqual(valves.map((v) => v.links).sort(), [['clg_coil'], ['htg_coil']]);
});

test('demo model: every property resolves to exactly one Open-FDD role', () => {
  const m = discoverText(DEMO);
  assert.equal(m.properties.total, 41);
  assert.equal(m.properties.matched, 41);
  assert.deepEqual(m.properties.unmatched, []);
  assert.deepEqual(m.properties.ambiguous, []);
  const roles = new Set(S.points(m.ahus[0]).map((p) => p.role));
  for (const r of roles) assert.ok(vocab.roles.some((v) => v.role === r), r);
  for (const r of ['supply_fan_speed_command', 'damper_position_command', 'damper_position', 'discharge_air_volume_flow_rate',
    'discharge_air_static_pressure', 'discharge_air_temperature', 'terminal_unit_discharge_air_temperature', 'mixed_air_temperature', 'zone_air_temperature']) {
    assert.ok(roles.has(r), r);
  }
});

test('the AHU and terminal discharge temperatures get different roles from context alone', () => {
  const pts = S.points(discoverText(DEMO).ahus[0]);
  assert.equal(pts.find((p) => p.id === 'dat').role, 'discharge_air_temperature');
  assert.equal(pts.find((p) => p.id === 'vav_02_dat').role, 'terminal_unit_discharge_air_temperature');
});

test('a different site model produces a different UI: two terminals, no hard-coded names', () => {
  const two = without(DEMO, ['vav_03', 'space_03', 'zone_03']);
  const m = discoverText(two);
  assert.equal(m.ahus[0].terminals.length, 2);
  assert.deepEqual(m.properties.unmatched, []);
  const renamed = discoverText(DEMO.replaceAll('VAV-0', 'TU-').replaceAll('"AHU-1"', '"Rooftop 7"'));
  assert.equal(renamed.ahus[0].label, 'Rooftop 7');
  assert.deepEqual(renamed.ahus[0].terminals.map((t) => t.label), ['TU-1 Office', 'TU-2 Conference', 'TU-3 Corridor']);
});

test('scenarios come from the model, not the code', () => {
  assert.deepEqual(discoverText(DEMO).scenarios, [{ part: 'vav_03_damper', spec: 'stuck:38' }]);
  assert.deepEqual(discoverText(DEMO.replace('ext:simFault "stuck:38" ;', '')).scenarios, []);
});

test('ambiguous and unmatched properties are reported, not guessed', () => {
  const extra = `${DEMO}
bldg:mystery a s223:QuantifiableObservableProperty ;
    qudt:hasQuantityKind quantitykind:Luminance .
bldg:ahu_1 s223:hasProperty bldg:mystery .
`;
  const m = discoverText(extra);
  assert.deepEqual(m.properties.unmatched, ['mystery']);
  assert.equal(S.points(m.ahus[0]).find((p) => p.id === 'mystery').role, null);
});

test('a model with no air handler warns', () => {
  const m = discoverText('@prefix s223: <http://data.ashrae.org/standard223#> .\n<urn:x:a> a s223:Fan .\n');
  assert.equal(m.ahus.length, 0);
  assert.ok(m.warnings.some((w) => /AirHandlingUnit/.test(w)));
});

test('prefixes and literals come through the Oxigraph parse', () => {
  const p = S.parseTurtle(oxigraph, DEMO);
  assert.equal(p.prefixes.bldg, 'urn:demo-site:');
  const g = S.graph(p);
  assert.equal(g.literal('bldg:vav_02_flow_max', 's223:hasValue'), 600);
  assert.equal(S.localId('urn:demo-site:vav_01'), 'vav_01');
  assert.throws(() => S.parseTurtle(oxigraph, '@prefix x: <urn:x:> .\nx:a x:b '));
});

test('generated role vocabulary is fresh', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-roles-223p.js'), '--check'], { cwd: ROOT, stdio: 'pipe' });
});
