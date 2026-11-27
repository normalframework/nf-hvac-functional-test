import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { haystackProjection } = require('../hooks/lib/model/vocabulary');
const {
  assertPinReady,
  assertSameRoleNames,
  diffRoleNames,
  readOpenfddPin,
  roleNames,
} = require('../hooks/lib/roles_sync');

test('the roles pin stays on a commit and is not flipped to v5.0.22', () => {
  const pin = readOpenfddPin();
  assert.equal(assertPinReady(pin), pin);
  assert.equal(pin.pinned_to_tag, false);
  assert.equal(pin.version, '1.1.0-draft.1');
  assert.equal(pin.intended_tag, 'v5.0.22');
  assert.match(pin.upstream.ref, /^[0-9a-f]{40}$/);
  const doc = JSON.parse(fs.readFileSync(pin.path, 'utf8'));
  assert.equal(doc.version, pin.version);
  assert.equal(doc.openfdd_release, '5.0.22');
  assert.equal(doc.status, 'draft');
});

test('a flipped pin and a tag ref are refused', () => {
  const pin = readOpenfddPin();
  assert.throws(() => assertPinReady({ ...pin, pinned_to_tag: true }), (error) => /** @type {any} */ (error).code === 'pin_flipped');
  assert.throws(() => assertPinReady({ ...pin, pinned_to_tag: 'later' }), (error) => /** @type {any} */ (error).code === 'pin_shape');
  assert.throws(() => assertPinReady({ ...pin, upstream: { ref: 'v5.0.22' } }), (error) => /** @type {any} */ (error).code === 'pin_not_a_commit');
  assert.throws(() => assertPinReady({ ...pin, intended_tag: 'v5.0.21' }), (error) => /** @type {any} */ (error).code === 'pin_tag');
  assert.throws(() => assertPinReady(null), (error) => /** @type {any} */ (error).code === 'pin_flipped');
});

test('role name drift fails the sync check', () => {
  const names = roleNames({ roles: [{ role: 'discharge_air_temperature' }, { role: 'supply_fan_command' }, { role: 1 }] });
  assert.deepEqual(names, ['discharge_air_temperature', 'supply_fan_command']);
  assert.deepEqual(diffRoleNames(names, names), { missing: [], extra: [] });
  const drifted = diffRoleNames(['supply_fan_command'], ['supply_fan_command', 'zone_air_temperature']);
  assert.deepEqual(drifted.missing, ['zone_air_temperature']);
  assert.deepEqual(diffRoleNames(['extra_role'], []).extra, ['extra_role']);
  assert.throws(() => assertSameRoleNames(['a'], ['a', 'b']), (error) => /** @type {any} */ (error).code === 'role_name_drift');
  assert.throws(() => assertSameRoleNames(['a', 'a'], ['a']), (error) => /** @type {any} */ (error).code === 'role_name_drift');
  assert.deepEqual(assertSameRoleNames(['b', 'a'], ['a', 'b']), { missing: [], extra: [] });
});

test('a pin file can be read from an explicit path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  const file = path.join(dir, 'pin.json');
  const pin = readOpenfddPin();
  fs.writeFileSync(file, JSON.stringify(pin));
  assert.equal(readOpenfddPin(file).sha256, pin.sha256);
});

test('the shipped Haystack map role names match the vocabulary projection', () => {
  const file = JSON.parse(fs.readFileSync('schema/haystack-role-map.json', 'utf8'));
  const live = haystackProjection();
  assert.deepEqual(file.roles.map((entry) => entry.role), live.roles.map((entry) => entry.role));
  assert.deepEqual(file.roles, live.roles);
});
