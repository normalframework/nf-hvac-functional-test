import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyDefaults } = require('../hooks/lib/config/defaults');
const { evaluateInterlocks } = require('../hooks/lib/interlocks');
const { economizerEligible, assessPriority } = require('../hooks/lib/capability');

const config = applyDefaults({ version: 1, limits: { max_sample_age_s: 30 } });
const memory = { outOfBandSince: null, staleStrikes: 0 };

/**
 * @param {Record<string, number | boolean | string>} values
 * @param {number} [age]
 */
function readings(values, age = 0) {
  /** @type {Record<string, { value: number | boolean | string, age_s: number }>} */
  const out = {};
  for (const [role, value] of Object.entries(values)) out[role] = { value, age_s: age };
  return out;
}

test('each interlock trips and a fresh sample clears the stale streak', () => {
  assert.equal(evaluateInterlocks(config, readings({ discharge_air_static_pressure: 1200 }), memory, 0).trip, 'duct_static_high');
  assert.equal(evaluateInterlocks(config, readings({
    mixed_air_temperature: 4,
    outdoor_air_intake_damper_position_command: 20,
  }), memory, 0).trip, 'mixed_air_low');
  assert.equal(evaluateInterlocks(config, readings({
    mixed_air_temperature: 4,
    outdoor_air_intake_damper_position_command: 0,
  }), memory, 0).trip, null);
  assert.equal(evaluateInterlocks(config, readings({ discharge_air_temperature: 2 }), memory, 0).trip, 'discharge_air_low');
  assert.equal(evaluateInterlocks(config, readings({ supply_fan_operating_status: false }), memory, 0).trip, 'fan_status_lost');
  assert.equal(evaluateInterlocks(config, readings({ air_temperature_low_limit_alarm_status: true }), memory, 0).trip, 'freeze_protection');
  assert.equal(evaluateInterlocks(config, readings({ air_smoke_alarm_status: true }), memory, 0).trip, 'smoke_alarm');
  assert.equal(evaluateInterlocks(config, readings({ air_temperature_low_limit_alarm_status: 1 }), memory, 0).trip, 'freeze_protection');
  assert.equal(evaluateInterlocks(config, readings({ air_smoke_alarm_status: 'active' }), memory, 0).trip, 'smoke_alarm');
  assert.equal(evaluateInterlocks(config, readings({ supply_fan_operating_status: 0 }), memory, 0).trip, 'fan_status_lost');
  assert.equal(evaluateInterlocks(config, readings({ supply_fan_operating_status: 'inactive' }), memory, 0).trip, 'fan_status_lost');

  const first = evaluateInterlocks(config, readings({ zone_air_temperature: 30 }), memory, 0);
  assert.equal(first.trip, null);
  const later = evaluateInterlocks(config, readings({ zone_air_temperature: 30 }), first.memory, 5 * 60 * 1000);
  assert.equal(later.trip, 'zone_out_of_band');
  const back = evaluateInterlocks(config, readings({ zone_air_temperature: 22 }), later.memory, 6 * 60 * 1000);
  assert.equal(back.memory.outOfBandSince, null);

  const stale = evaluateInterlocks(config, readings({ discharge_air_static_pressure: 100 }, 90), memory, 0);
  assert.equal(stale.trip, null);
  assert.equal(evaluateInterlocks(config, readings({ discharge_air_static_pressure: 100 }, 90), stale.memory, 1).trip, 'stale_data');
  const cleared = evaluateInterlocks(config, readings({ discharge_air_static_pressure: 100 }, 0), stale.memory, 2);
  assert.equal(cleared.memory.staleStrikes, 0);
});

test('economizer bounds and priority slots', () => {
  const window = config.plan.econ_window;
  assert.equal(economizerEligible({ oat: 12, rat: 22, rh: 40 }, window), true);
  assert.equal(economizerEligible({ oat: 9, rat: 22, rh: 40 }, window), false);
  assert.equal(economizerEligible({ oat: 12, rat: 13, rh: 40 }, window), false);
  assert.equal(economizerEligible({ oat: 12, rat: 22, rh: 90 }, window), false);
  assert.equal(economizerEligible({ oat: null, rat: 22, rh: 40 }, window), false);
  assert.deepEqual(assessPriority([null, null, null, null, null, null, null, null], 8), { ok: true, reason: null });
  assert.equal(assessPriority([null, 1, null, null, null, null, null, null], 8).reason, 'higher_priority_override');
  assert.equal(assessPriority([null, null, null, null, null, null, null, 5], 8).reason, 'slot_occupied');
  assert.equal(assessPriority(/** @type {any} */ (null), 8).reason, 'no_priority_array');
});
