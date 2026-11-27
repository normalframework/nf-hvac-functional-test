import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateSiteConfig, loadSiteConfig } = require('../hooks/lib/config');
const { semanticIssues } = require('../hooks/lib/config/semantic');
const { liveWritesAllowed } = require('../hooks/lib/config/gates');
const { isOnAllowList, writableAllowList } = require('../hooks/lib/config/allowlist');
const { ConfigError } = require('../hooks/lib/config/errors');
const { minimalInput, point, uuid } = require('./fixtures/helpers');

/**
 * @param {{ code: string, path: string, message: string }[]} errors
 * @param {string} code
 */
function hasCode(errors, code) {
  return errors.some((error) => error.code === code);
}

test('example config validates and stays in dry-run', () => {
  const file = path.join(__dirname, '..', 'examples', 'site-config.example.json');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = validateSiteConfig(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.dry_run, true);
  assert.equal(result.config.write.bacnet_priority, 8);
  assert.equal(result.config.logging.mode, 'shadow');
  assert.equal(result.config.limits.max_sample_age_s, 120);
  const writes = writableAllowList(result.config).map((entry) => entry.role);
  assert.ok(writes.includes('outdoor_air_intake_damper_position_command'));
  assert.ok(!writes.includes('supply_fan_command'));
  assert.equal(isOnAllowList(result.config, 'ahu_a', 'heating_valve_position_command'), true);
  assert.equal(isOnAllowList(result.config, 'ahu_a', 'supply_fan_operating_status'), false);
});

test('defaults dry-run on and priority 8', () => {
  const result = validateSiteConfig(minimalInput());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.dry_run, true);
  assert.equal(result.config.write.bacnet_priority, 8);
  assert.equal(result.config.write.backend, 'nf_command');
  assert.equal(result.config.plan.ahu_strategy, 'per_point');
  const vavStep = result.config.plan.steps.find((/** @type {{ step_id: string }} */ step) => step.step_id === 'vav.max_cool');
  assert.equal(vavStep.enabled, false);
  assert.equal(result.config.logging.max_reads_per_s, 50);
});

test('priorities 1 and 2 are rejected and the range is 3 to 16', () => {
  for (const priority of [1, 2]) {
    const input = minimalInput();
    input.write = { bacnet_priority: priority };
    const result = validateSiteConfig(input);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(hasCode(result.errors, 'priority_rejected'), true);
  }
  for (const priority of [0, 17, 8.5, -1]) {
    const input = minimalInput();
    input.write = { bacnet_priority: priority };
    const result = validateSiteConfig(input);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(hasCode(result.errors, 'priority_out_of_range') || hasCode(result.errors, 'schema'), true);
  }
  for (const priority of [3, 8, 16]) {
    const input = minimalInput();
    input.write = { bacnet_priority: priority };
    const result = validateSiteConfig(input);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.config.write.bacnet_priority, priority);
  }
});

test('unbound required role fails', () => {
  const input = minimalInput();
  delete input.equipment[0].points.discharge_air_temperature;
  const result = validateSiteConfig(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(hasCode(result.errors, 'role_unbound'), true);
});

test('writable allow-list rejects read roles and ignores a missing write flag', () => {
  const readFlag = minimalInput();
  readFlag.equipment[0].points.supply_fan_command = point(40);
  readFlag.equipment[0].points.supply_fan_command.writable = true;
  const rejected = validateSiteConfig(readFlag);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(hasCode(rejected.errors, 'writable_not_allowed'), true);

  const missingFlag = minimalInput();
  delete missingFlag.equipment[0].points.cooling_valve_position_command.writable;
  const optionalWrite = validateSiteConfig(missingFlag);
  assert.equal(optionalWrite.ok, true);
  if (optionalWrite.ok) assert.equal(isOnAllowList(optionalWrite.config, 'ahu_a', 'cooling_valve_position_command'), false);

  const optional = minimalInput();
  optional.equipment[0].points.return_damper_position_command = point(41);
  const ok = validateSiteConfig(optional);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(isOnAllowList(ok.config, 'ahu_a', 'return_damper_position_command'), false);
});

test('write roles may be absent from config; the model planner decides the steps', () => {
  const input = minimalInput();
  input.plan = { ahu_strategy: 'mode_point' };
  delete input.equipment[0].points.outdoor_air_intake_damper_position_command;
  delete input.equipment[0].points.cooling_valve_position_command;
  delete input.equipment[0].points.heating_valve_position_command;
  assert.equal(validateSiteConfig(input).ok, true);

  const vav = minimalInput();
  vav.vav_test = { strategy: 'bas_toggle' };
  vav.plan = {
    steps: [
      { step_id: 'ahu.baseline' },
      { step_id: 'ahu.recirc' },
      { step_id: 'vav.max_cool', enabled: true, hold_minutes: 30 },
      { step_id: 'recovery' },
    ],
  };
  assert.equal(validateSiteConfig(vav).ok, true);
});

test('vav hold, order, and unimplemented catalog steps', () => {
  const short = minimalInput();
  short.plan = {
    steps: [
      { step_id: 'ahu.recirc' },
      { step_id: 'vav.max_cool', enabled: true, hold_minutes: 4 },
      { step_id: 'recovery' },
    ],
  };
  const hold = validateSiteConfig(short);
  assert.equal(hold.ok, false);
  if (!hold.ok) assert.equal(hasCode(hold.errors, 'vav_hold'), true);

  const order = minimalInput();
  order.plan = {
    steps: [
      { step_id: 'vav.max_cool', enabled: true, hold_minutes: 30 },
      { step_id: 'ahu.recirc' },
      { step_id: 'recovery' },
    ],
  };
  const ordered = validateSiteConfig(order);
  assert.equal(ordered.ok, false);
  if (!ordered.ok) assert.equal(hasCode(ordered.errors, 'vav_order'), true);

  const later = minimalInput();
  later.plan = { steps: [{ step_id: 'ahu.fan_off', enabled: true }, { step_id: 'recovery' }] };
  const blocked = validateSiteConfig(later);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(hasCode(blocked.errors, 'step_not_implemented'), true);

  const parked = minimalInput();
  parked.plan = { steps: [{ step_id: 'ahu.baseline' }, { step_id: 'ahu.fan_off', enabled: false }, { step_id: 'recovery' }] };
  assert.equal(validateSiteConfig(parked).ok, true);
});

test('live writes need dry_run false and confirm_live true', () => {
  const result = validateSiteConfig(minimalInput());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(liveWritesAllowed(result.config, true), false);
  const live = structuredClone(result.config);
  live.dry_run = false;
  assert.equal(liveWritesAllowed(live, false), false);
  assert.equal(liveWritesAllowed(live, undefined), false);
  assert.equal(liveWritesAllowed(live, true), true);
  assert.equal(liveWritesAllowed(null, true), false);
});

test('cross-field rules', () => {
  const lease = minimalInput();
  lease.write = { command_lease_s: 60, keepalive_s: 60 };
  const leased = validateSiteConfig(lease);
  assert.equal(leased.ok, false);
  if (!leased.ok) assert.equal(hasCode(leased.errors, 'lease'), true);

  const econ = minimalInput();
  econ.plan = { econ_window: { low_c: 20, high_c: 10 } };
  const window = validateSiteConfig(econ);
  assert.equal(window.ok, false);
  if (!window.ok) assert.equal(hasCode(window.errors, 'econ_window'), true);

  const dup = minimalInput();
  dup.equipment[0].points.return_air_temperature.uuid = dup.equipment[0].points.discharge_air_temperature.uuid;
  const duplicated = validateSiteConfig(dup);
  assert.equal(duplicated.ok, false);
  if (!duplicated.ok) assert.equal(hasCode(duplicated.errors, 'duplicate_uuid'), true);

  const serves = minimalInput();
  serves.equipment[0].serves = ['vav_09'];
  const served = validateSiteConfig(serves);
  assert.equal(served.ok, false);
  if (!served.ok) assert.equal(hasCode(served.errors, 'serves'), true);

  const unknown = minimalInput();
  unknown.equipment[0].points.made_up_role = point(70);
  const badRole = validateSiteConfig(unknown);
  assert.equal(badRole.ok, false);
  if (!badRole.ok) assert.equal(hasCode(badRole.errors, 'unknown_role'), true);

  assert.equal(validateSiteConfig(null).ok, false);
  assert.throws(() => loadSiteConfig({ version: 1 }), ConfigError);
});

test('query binding is accepted and a point cannot carry both uuid and query', () => {
  const input = minimalInput();
  input.equipment[0].points.outdoor_air_intake_relative_humidity = {
    query: { equip_ref: 'ahu_a', markers: ['outside', 'air', 'humidity'] },
  };
  assert.equal(validateSiteConfig(input).ok, true);
  input.equipment[0].points.outdoor_air_intake_relative_humidity = {
    uuid: uuid(80),
    layer: 'hpl:bacnet:1',
    query: { equip_ref: 'ahu_a' },
  };
  assert.equal(validateSiteConfig(input).ok, false);
});

test('loadSiteConfig returns the defaulted document', () => {
  const config = loadSiteConfig(minimalInput());
  assert.equal(config.dry_run, true);
  assert.equal(config.write.bacnet_priority, 8);
});

test('semantic rules outside the schema', () => {
  const zone = minimalInput();
  zone.interlocks = { zone_air_temperature_min_c: 30, zone_air_temperature_max_c: 20 };
  const zoned = validateSiteConfig(zone);
  assert.equal(zoned.ok, false);
  if (!zoned.ok) assert.equal(hasCode(zoned.errors, 'zone_band'), true);

  const batch = minimalInput();
  batch.limits = { max_boxes_overridden: 4 };
  batch.vav_test = { batch_size: 5 };
  const batched = validateSiteConfig(batch);
  assert.equal(batched.ok, false);
  if (!batched.ok) assert.equal(hasCode(batched.errors, 'batch_size'), true);

  const onlyVav = {
    version: 1,
    equipment: [{ id: 'vav_01', type: 'vav', points: { zone_air_temperature: point(90) }, serves: ['ahu_a'] }],
  };
  const noAhu = validateSiteConfig(onlyVav);
  assert.equal(noAhu.ok, false);
  if (!noAhu.ok) {
    assert.equal(hasCode(noAhu.errors, 'equipment'), true);
    assert.equal(hasCode(noAhu.errors, 'serves'), true);
  }

  const dup = minimalInput();
  dup.equipment.push({ id: 'ahu_a', type: 'ahu', points: {} });
  const duplicated = validateSiteConfig(dup);
  assert.equal(duplicated.ok, false);
  if (!duplicated.ok) assert.equal(hasCode(duplicated.errors, 'duplicate_equipment'), true);

  const misplaced = minimalInput();
  misplaced.equipment[0].points.purge_operating_mode_command = point(91);
  const placed = validateSiteConfig(misplaced);
  assert.equal(placed.ok, false);
  if (!placed.ok) assert.equal(hasCode(placed.errors, 'role_equipment'), true);

  const bare = minimalInput();
  delete bare.equipment[0].points.discharge_air_static_pressure.layer;
  const bareResult = validateSiteConfig(bare);
  assert.equal(bareResult.ok, false);
  if (!bareResult.ok) assert.equal(hasCode(bareResult.errors, 'binding_shape'), true);

  const ok = validateSiteConfig(minimalInput());
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  const crafted = structuredClone(ok.config);
  crafted.write.bacnet_priority = 2;
  assert.equal(hasCode(semanticIssues(crafted), 'priority_rejected'), true);
  crafted.write.bacnet_priority = 8;
  crafted.vav_test.airflow_setpoint_hard_cap_m3s = 0;
  assert.equal(hasCode(semanticIssues(crafted), 'airflow_cap'), true);
  crafted.vav_test.airflow_setpoint_hard_cap_m3s = null;
  crafted.vav_test.airflow_setpoint_default_m3s = -0.1;
  assert.equal(hasCode(semanticIssues(crafted), 'airflow_default'), true);
  crafted.plan.ahu_strategy = 'mode_point';
  delete crafted.plan.mode_point_values['ahu.recirc'];
  assert.equal(hasCode(semanticIssues(crafted), 'mode_point_values'), true);
});

test('recovery must be last and backoff must cover retries', () => {
  const input = minimalInput();
  input.plan = { steps: [{ step_id: 'recovery' }, { step_id: 'ahu.baseline' }] };
  const order = validateSiteConfig(input);
  assert.equal(order.ok, false);
  if (!order.ok) assert.equal(hasCode(order.errors, 'recovery_order'), true);

  const backoff = minimalInput();
  backoff.write = { release_retries: 4, release_backoff_s: [5, 10] };
  const short = validateSiteConfig(backoff);
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(hasCode(short.errors, 'backoff'), true);
});
