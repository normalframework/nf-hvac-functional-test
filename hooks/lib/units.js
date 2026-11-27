'use strict';

const { getRole } = require('./roles');

/** @type {Record<string, { si: string, toSi: (value: number) => number, fromSi: (value: number) => number }>} */
const CONVERSIONS = {
  DEG_C: { si: 'DEG_C', toSi: (value) => value, fromSi: (value) => value },
  degC: { si: 'DEG_C', toSi: (value) => value, fromSi: (value) => value },
  degF: { si: 'DEG_C', toSi: (value) => ((value - 32) * 5) / 9, fromSi: (value) => (value * 9) / 5 + 32 },
  K: { si: 'DEG_C', toSi: (value) => value - 273.15, fromSi: (value) => value + 273.15 },
  PA: { si: 'PA', toSi: (value) => value, fromSi: (value) => value },
  Pa: { si: 'PA', toSi: (value) => value, fromSi: (value) => value },
  inH2O: { si: 'PA', toSi: (value) => value * 249.088908333, fromSi: (value) => value / 249.088908333 },
  psi: { si: 'PA', toSi: (value) => value * 6894.757293168, fromSi: (value) => value / 6894.757293168 },
  PERCENT: { si: 'PERCENT', toSi: (value) => value, fromSi: (value) => value },
  '%': { si: 'PERCENT', toSi: (value) => value, fromSi: (value) => value },
  PERCENT_RH: { si: 'PERCENT_RH', toSi: (value) => value, fromSi: (value) => value },
  '%RH': { si: 'PERCENT_RH', toSi: (value) => value, fromSi: (value) => value },
  'L-PER-SEC': { si: 'L-PER-SEC', toSi: (value) => value, fromSi: (value) => value },
  'L/s': { si: 'L-PER-SEC', toSi: (value) => value, fromSi: (value) => value },
  'm3/s': { si: 'L-PER-SEC', toSi: (value) => value * 1000, fromSi: (value) => value / 1000 },
  cfm: { si: 'L-PER-SEC', toSi: (value) => value * 0.4719474432, fromSi: (value) => value / 0.4719474432 },
};

/**
 * Convert a numeric reading into the SI unit used by thresholds.
 * Unknown or mismatched units fail closed.
 * @param {unknown} value
 * @param {string} fromUnit
 * @param {string} targetUnit
 * @returns {{ ok: true, value: number, unit: string } | { ok: false, reason: string }}
 */
function convertToSi(value, fromUnit, targetUnit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: 'not_a_number' };
  }
  const spec = CONVERSIONS[fromUnit];
  if (!spec) return { ok: false, reason: 'unknown_unit' };
  if (spec.si !== targetUnit) return { ok: false, reason: 'unit_mismatch' };
  return { ok: true, value: spec.toSi(value), unit: spec.si };
}

/**
 * Convert an SI command into the device's native unit.
 * @param {unknown} value
 * @param {string} toUnit
 * @param {string} sourceUnit
 * @returns {{ ok: true, value: number, unit: string } | { ok: false, reason: string }}
 */
function convertFromSi(value, toUnit, sourceUnit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: 'not_a_number' };
  }
  const spec = CONVERSIONS[toUnit];
  if (!spec) return { ok: false, reason: 'unknown_unit' };
  if (spec.si !== sourceUnit) return { ok: false, reason: 'unit_mismatch' };
  return { ok: true, value: spec.fromSi(value), unit: toUnit };
}

/**
 * SI unit a numeric role is judged in. Boolean and enum roles are not converted.
 * @param {string} roleId
 */
function siUnitFor(roleId) {
  const role = getRole(roleId);
  if (!role) return null;
  if (role.unit === 'bool_or_percent') return 'PERCENT';
  if (role.unit === 'bool' || role.unit === 'enum' || role.unit === 'bool_or_enum') return null;
  return role.unit;
}

/**
 * @param {any} point
 * @param {number | boolean | null} value
 * @returns {{ ok: true, value: number | boolean | null } | { ok: false, reason: string }}
 */
function deviceNumber(point, value) {
  if (!point || !point.unit || typeof value !== 'number') return { ok: true, value };
  const source = siUnitFor(point.role);
  if (!source) return { ok: true, value };
  const converted = convertFromSi(value, point.unit, source);
  if (!converted.ok) return converted;
  return { ok: true, value: converted.value };
}

module.exports = { convertToSi, convertFromSi, deviceNumber, siUnitFor, CONVERSIONS };
