'use strict';

/**
 * Target is the box maximum when that point exists, else the configured default, then the hard cap.
 * @param {{ maximum: number | null, fallback: number | null, hardCap: number | null }} spec
 */
function airflowTarget(spec) {
  let value = spec.maximum !== null && spec.maximum !== undefined ? spec.maximum : spec.fallback;
  if (value === null || value === undefined) return { ok: false, reason: 'role_unbound:discharge_air_volume_flow_rate_setpoint' };
  if (spec.hardCap !== null && spec.hardCap !== undefined) value = Math.min(value, spec.hardCap);
  if (!(value > 0)) return { ok: false, reason: 'airflow_not_positive' };
  return { ok: true, value };
}

module.exports = { airflowTarget };
