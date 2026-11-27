'use strict';

const { PRIORITY_DEFAULT } = require('./priority');

const V01_STEP_IDS = Object.freeze([
  'ahu.baseline',
  'ahu.recirc',
  'ahu.economizer',
  'vav.max_cool',
  'recovery',
]);

const CATALOG_STEP_IDS = Object.freeze([
  'ahu.fan_off',
  'ahu.fan_min_speed',
  'ahu.damper_stroke',
  'ahu.valve_stroke',
  'ahu.startup_static',
  'ahu.economizer_mech',
]);

const STEP_IDS = Object.freeze([...V01_STEP_IDS, ...CATALOG_STEP_IDS]);

const AHU_CONDITIONING_STEPS = Object.freeze(['ahu.recirc', 'ahu.economizer']);

/** @type {Record<string, { hold_minutes: number, settle_minutes: number, enabled?: boolean, conditional?: string }>} */
const STEP_DEFAULTS = {
  'ahu.baseline': { hold_minutes: 5, settle_minutes: 0 },
  'ahu.recirc': { hold_minutes: 20, settle_minutes: 5 },
  'ahu.economizer': { hold_minutes: 20, settle_minutes: 5, conditional: 'econ_window' },
  'vav.max_cool': { enabled: false, hold_minutes: 30, settle_minutes: 5 },
  recovery: { hold_minutes: 10, settle_minutes: 0 },
  'ahu.fan_off': { enabled: false, hold_minutes: 5, settle_minutes: 1 },
  'ahu.fan_min_speed': { enabled: false, hold_minutes: 5, settle_minutes: 1 },
  'ahu.damper_stroke': { enabled: false, hold_minutes: 5, settle_minutes: 1 },
  'ahu.valve_stroke': { enabled: false, hold_minutes: 5, settle_minutes: 1 },
  'ahu.startup_static': { enabled: false, hold_minutes: 5, settle_minutes: 1 },
  'ahu.economizer_mech': { enabled: false, hold_minutes: 20, settle_minutes: 5 },
};

const DEFAULT_STEPS = [
  { step_id: 'ahu.baseline', hold_minutes: 5, settle_minutes: 0 },
  { step_id: 'ahu.recirc', hold_minutes: 20, settle_minutes: 5 },
  { step_id: 'ahu.economizer', hold_minutes: 20, settle_minutes: 5, conditional: 'econ_window' },
  { step_id: 'vav.max_cool', enabled: false, hold_minutes: 30, settle_minutes: 5 },
  { step_id: 'recovery', hold_minutes: 10, settle_minutes: 0 },
];

const DEFAULT_MODE_VALUES = {
  'ahu.recirc': 1,
  'ahu.economizer': 2,
};

/**
 * @param {unknown} input
 * @returns {boolean}
 */
function isPlainObject(input) {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input);
}

/**
 * @param {unknown} steps
 * @returns {any[]}
 */
function normalizeSteps(steps) {
  const source = Array.isArray(steps) ? steps : DEFAULT_STEPS;
  return source.map((step) => {
    const raw = isPlainObject(step) ? step : {};
    const id = typeof raw.step_id === 'string' ? raw.step_id : '';
    const defaults = STEP_DEFAULTS[id] || { hold_minutes: 5, settle_minutes: 0 };
    const enabled = Object.prototype.hasOwnProperty.call(raw, 'enabled')
      ? raw.enabled
      : Object.prototype.hasOwnProperty.call(defaults, 'enabled')
        ? defaults.enabled
        : true;
    /** @type {Record<string, unknown>} */
    const out = {
      step_id: raw.step_id,
      hold_minutes: Object.prototype.hasOwnProperty.call(raw, 'hold_minutes') ? raw.hold_minutes : defaults.hold_minutes,
      settle_minutes: Object.prototype.hasOwnProperty.call(raw, 'settle_minutes') ? raw.settle_minutes : defaults.settle_minutes,
      enabled,
    };
    if (Object.prototype.hasOwnProperty.call(raw, 'conditional')) out.conditional = raw.conditional;
    else if (defaults.conditional) out.conditional = defaults.conditional;
    return out;
  });
}

/**
 * Fill omitted fields. Does not drop unknown keys; schema validation runs on the raw input.
 * @param {Record<string, any>} input
 */
function applyDefaults(input) {
  const write = isPlainObject(input.write) ? input.write : {};
  const limits = isPlainObject(input.limits) ? input.limits : {};
  const interlocks = isPlainObject(input.interlocks) ? input.interlocks : {};
  const logging = isPlainObject(input.logging) ? input.logging : {};
  const plan = isPlainObject(input.plan) ? input.plan : {};
  const vav = isPlainObject(input.vav_test) ? input.vav_test : {};
  const econ = isPlainObject(plan.econ_window) ? plan.econ_window : {};
  const modeValues = isPlainObject(plan.mode_point_values) ? plan.mode_point_values : {};
  const vavValues = isPlainObject(vav.values) ? vav.values : {};

  return {
    version: input.version,
    dry_run: Object.prototype.hasOwnProperty.call(input, 'dry_run') ? input.dry_run : true,
    dry_run_time_scale: Object.prototype.hasOwnProperty.call(input, 'dry_run_time_scale') ? input.dry_run_time_scale : 1,
    max_concurrent_runs: Object.prototype.hasOwnProperty.call(input, 'max_concurrent_runs') ? input.max_concurrent_runs : 1,
    allowed_windows: Array.isArray(input.allowed_windows) ? input.allowed_windows : [],
    write: {
      backend: Object.prototype.hasOwnProperty.call(write, 'backend') ? write.backend : 'nf_command',
      bacnet_priority: Object.prototype.hasOwnProperty.call(write, 'bacnet_priority') ? write.bacnet_priority : PRIORITY_DEFAULT,
      command_lease_s: Object.prototype.hasOwnProperty.call(write, 'command_lease_s') ? write.command_lease_s : 300,
      keepalive_s: Object.prototype.hasOwnProperty.call(write, 'keepalive_s') ? write.keepalive_s : 60,
      verify_s: Object.prototype.hasOwnProperty.call(write, 'verify_s') ? write.verify_s : 30,
      release_retries: Object.prototype.hasOwnProperty.call(write, 'release_retries') ? write.release_retries : 6,
      release_backoff_s: Array.isArray(write.release_backoff_s) ? write.release_backoff_s.slice() : [5, 10, 20, 40, 60, 120],
    },
    limits: {
      max_total_minutes: Object.prototype.hasOwnProperty.call(limits, 'max_total_minutes') ? limits.max_total_minutes : 150,
      max_tick_gap_s: Object.prototype.hasOwnProperty.call(limits, 'max_tick_gap_s') ? limits.max_tick_gap_s : 60,
      max_comm_failures: Object.prototype.hasOwnProperty.call(limits, 'max_comm_failures') ? limits.max_comm_failures : 3,
      max_boxes_overridden: Object.prototype.hasOwnProperty.call(limits, 'max_boxes_overridden') ? limits.max_boxes_overridden : 25,
      max_sample_age_s: Object.prototype.hasOwnProperty.call(limits, 'max_sample_age_s') ? limits.max_sample_age_s : 120,
    },
    interlocks: {
      duct_static_pressure_max_pa: Object.prototype.hasOwnProperty.call(interlocks, 'duct_static_pressure_max_pa') ? interlocks.duct_static_pressure_max_pa : 1000,
      mixed_air_temperature_min_c: Object.prototype.hasOwnProperty.call(interlocks, 'mixed_air_temperature_min_c') ? interlocks.mixed_air_temperature_min_c : 7,
      discharge_air_temperature_min_c: Object.prototype.hasOwnProperty.call(interlocks, 'discharge_air_temperature_min_c') ? interlocks.discharge_air_temperature_min_c : 5,
      zone_air_temperature_min_c: Object.prototype.hasOwnProperty.call(interlocks, 'zone_air_temperature_min_c') ? interlocks.zone_air_temperature_min_c : 18,
      zone_air_temperature_max_c: Object.prototype.hasOwnProperty.call(interlocks, 'zone_air_temperature_max_c') ? interlocks.zone_air_temperature_max_c : 27,
      fan_status_loss_abort: Object.prototype.hasOwnProperty.call(interlocks, 'fan_status_loss_abort') ? interlocks.fan_status_loss_abort : true,
      freeze_protection_status_abort: Object.prototype.hasOwnProperty.call(interlocks, 'freeze_protection_status_abort') ? interlocks.freeze_protection_status_abort : true,
      smoke_alarm_status_abort: Object.prototype.hasOwnProperty.call(interlocks, 'smoke_alarm_status_abort') ? interlocks.smoke_alarm_status_abort : true,
    },
    logging: {
      mode: Object.prototype.hasOwnProperty.call(logging, 'mode') ? logging.mode : 'shadow',
      sample_interval_s: Object.prototype.hasOwnProperty.call(logging, 'sample_interval_s') ? logging.sample_interval_s : 20,
      boost_period_s: Object.prototype.hasOwnProperty.call(logging, 'boost_period_s') ? logging.boost_period_s : 30,
      max_boosted_points: Object.prototype.hasOwnProperty.call(logging, 'max_boosted_points') ? logging.max_boosted_points : 60,
      recovery_minutes: Object.prototype.hasOwnProperty.call(logging, 'recovery_minutes') ? logging.recovery_minutes : 10,
      max_reads_per_s: Object.prototype.hasOwnProperty.call(logging, 'max_reads_per_s') ? logging.max_reads_per_s : 50,
    },
    plan: {
      steps: normalizeSteps(plan.steps),
      econ_window: {
        low_c: Object.prototype.hasOwnProperty.call(econ, 'low_c') ? econ.low_c : 10,
        high_c: Object.prototype.hasOwnProperty.call(econ, 'high_c') ? econ.high_c : 18,
        min_delta_k: Object.prototype.hasOwnProperty.call(econ, 'min_delta_k') ? econ.min_delta_k : 3,
        max_rh_pct: Object.prototype.hasOwnProperty.call(econ, 'max_rh_pct') ? econ.max_rh_pct : 70,
      },
      ahu_strategy: Object.prototype.hasOwnProperty.call(plan, 'ahu_strategy') ? plan.ahu_strategy : 'per_point',
      mode_point_values: Object.assign({}, DEFAULT_MODE_VALUES, modeValues),
    },
    vav_test: {
      strategy: Object.prototype.hasOwnProperty.call(vav, 'strategy') ? vav.strategy : 'airflow_setpoint',
      ahu_mode: Object.prototype.hasOwnProperty.call(vav, 'ahu_mode') ? vav.ahu_mode : 'auto',
      batch_size: Object.prototype.hasOwnProperty.call(vav, 'batch_size') ? vav.batch_size : 5,
      batch_delay_s: Object.prototype.hasOwnProperty.call(vav, 'batch_delay_s') ? vav.batch_delay_s : 20,
      min_capable_boxes: Object.prototype.hasOwnProperty.call(vav, 'min_capable_boxes') ? vav.min_capable_boxes : 1,
      values: {
        bas_toggle_on: Object.prototype.hasOwnProperty.call(vavValues, 'bas_toggle_on') ? vavValues.bas_toggle_on : 1,
        flush_on: Object.prototype.hasOwnProperty.call(vavValues, 'flush_on') ? vavValues.flush_on : 1,
      },
      airflow_setpoint_default_m3s: Object.prototype.hasOwnProperty.call(vav, 'airflow_setpoint_default_m3s') ? vav.airflow_setpoint_default_m3s : null,
      airflow_setpoint_hard_cap_m3s: Object.prototype.hasOwnProperty.call(vav, 'airflow_setpoint_hard_cap_m3s') ? vav.airflow_setpoint_hard_cap_m3s : null,
      bas_toggle_min_boxes_responding_pct: Object.prototype.hasOwnProperty.call(vav, 'bas_toggle_min_boxes_responding_pct') ? vav.bas_toggle_min_boxes_responding_pct : 60,
      per_box_strategy: Array.isArray(vav.per_box_strategy) ? vav.per_box_strategy.slice() : ['flush_point', 'airflow_setpoint'],
    },
    equipment: Array.isArray(input.equipment) ? structuredClone(input.equipment) : [],
  };
}

module.exports = {
  V01_STEP_IDS,
  CATALOG_STEP_IDS,
  STEP_IDS,
  AHU_CONDITIONING_STEPS,
  STEP_DEFAULTS,
  applyDefaults,
};
