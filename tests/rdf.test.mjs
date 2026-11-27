import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadRdfModel,
  loadRdfMap,
  RdfInputDisabledError,
  matchRoleIri,
  checkVendoredRoleFile,
  readPin,
} = require('../hooks/lib/model');
const { parseTtl } = require('../hooks/lib/model/rdf');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'rdf');
const BRICK_SENSOR = 'https://brickschema.org/schema/Brick#Sensor';
const LOCAL_SENSOR = 'urn:local:Sensor';
const ONTOLOGY_SHA256 = '08f80bd6e15052f28cdfd354bdf46ff96e5e1afdba36a4dbed5186fc1ea51c41';

/**
 * @param {string} name
 */
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/**
 * @param {() => void} fn
 */
function disabled(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof RdfInputDisabledError);
    assert.equal(err.name, 'RdfInputDisabledError');
    assert.equal(err.code, 'rdf_input_disabled');
    assert.match(err.message, /Oxigraph 0\.5\.13/);
    assert.match(err.message, /Haystack/);
    return true;
  });
}

test('rdf input fails closed on export shapes', () => {
  for (const name of ['object-list.ttl', 'prefix-blank.ttl', 'same-local-name.ttl', 'edge-shapes.ttl']) {
    const text = fixture(name);
    disabled(() => loadRdfModel(text));
    disabled(() => loadRdfModel(text, { roles: [] }));
    disabled(() => parseTtl(text));
  }
  disabled(() => loadRdfMap());
  assert.equal(fs.existsSync(path.join(ROOT, 'schema/rdf-role-map.json')), false);
});

test('a shared local name binds neither IRI by mistake', () => {
  const text = fixture('same-local-name.ttl');
  disabled(() => loadRdfModel(text));

  const byLocalName = new Map([['Sensor', 'discharge_air_temperature']]);
  assert.equal(matchRoleIri([BRICK_SENSOR, LOCAL_SENSOR], byLocalName), null);
  assert.equal(matchRoleIri([BRICK_SENSOR], byLocalName), null);
  assert.equal(matchRoleIri([LOCAL_SENSOR], byLocalName), null);

  const brickOnly = new Map([[BRICK_SENSOR, 'discharge_air_temperature']]);
  assert.equal(matchRoleIri([LOCAL_SENSOR], brickOnly), null);
  assert.equal(matchRoleIri([BRICK_SENSOR], brickOnly), 'discharge_air_temperature');

  const distinct = new Map([
    [BRICK_SENSOR, 'discharge_air_temperature'],
    [LOCAL_SENSOR, 'zone_air_temperature'],
  ]);
  assert.equal(matchRoleIri([BRICK_SENSOR, LOCAL_SENSOR], distinct), null);
  assert.equal(matchRoleIri(['', BRICK_SENSOR], brickOnly), 'discharge_air_temperature');
  assert.equal(matchRoleIri([BRICK_SENSOR], new Map([[BRICK_SENSOR, '']])), null);
});

test('the shared role file pin rejects a different hash', () => {
  const pin = readPin(ROOT);
  assert.equal(pin.status, 'not_vendored');
  assert.equal(pin.sha256, null);
  assert.equal(pin.oxigraph, '0.5.13');
  assert.equal(pin.ontology_sha256, ONTOLOGY_SHA256);
  assert.equal(pin.qudt, '3.4.0');
  assert.equal(pin.path, 'vendor/roles/shared-223p-roles.ttl');
  assert.equal(pin.validation.rdflib, '7.6.0');
  assert.equal(pin.validation.ontoenv, '0.6.4');
  assert.equal(pin.validation.pyshifty, '0.6.0');
  assert.equal(pin.validation.runs_on, 'ci_only');
  assert.deepEqual(checkVendoredRoleFile(ROOT), { vendored: false, sha256: null });
  assert.equal(fs.existsSync(path.join(ROOT, pin.path)), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-pin-'));
  fs.mkdirSync(path.join(dir, 'schema'));
  fs.mkdirSync(path.join(dir, 'vendor', 'roles'), { recursive: true });
  const bytes = Buffer.from('@prefix s223: <https://w3id.org/ashrae/223p#> .\n');
  const file = path.join(dir, pin.path);
  fs.writeFileSync(file, bytes);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(dir, 'schema/shared-role-file.pin.json'), JSON.stringify({
    ...pin,
    sha256: 'f'.repeat(64),
  }));
  assert.throws(() => checkVendoredRoleFile(dir), (err) => {
    const coded = /** @type {{ code: string }} */ (err);
    assert.equal(coded.code, 'role_file_hash_mismatch');
    return true;
  });

  fs.writeFileSync(path.join(dir, 'schema/shared-role-file.pin.json'), JSON.stringify({
    ...pin,
    sha256: actual,
  }));
  assert.deepEqual(checkVendoredRoleFile(dir), { vendored: true, sha256: actual });
  disabled(() => loadRdfModel(bytes.toString('utf8')));

  fs.rmSync(file);
  assert.throws(() => checkVendoredRoleFile(dir), (err) => {
    const coded = /** @type {{ code: string }} */ (err);
    assert.equal(coded.code, 'role_file_missing');
    return true;
  });

  fs.writeFileSync(path.join(dir, 'schema/shared-role-file.pin.json'), JSON.stringify({
    ...pin,
    oxigraph: '0.4.0',
    sha256: null,
  }));
  assert.throws(() => checkVendoredRoleFile(dir), (err) => {
    const coded = /** @type {{ code: string }} */ (err);
    assert.equal(coded.code, 'oxigraph_pin');
    return true;
  });
});
