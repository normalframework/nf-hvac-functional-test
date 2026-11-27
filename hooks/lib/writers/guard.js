'use strict';

const { getRole, valueInClamp } = require('../roles');
const { confirmRuntime } = require('../model/writable');

/**
 * Reject a non-finite value, a value outside the role clamp, or a point
 * whose priority array was not confirmed.
 * @param {any} point
 * @param {unknown} value
 * @param {{ priority_array?: boolean, readback_ok?: boolean | null } | null} [probe]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function guardWrite(point, value, probe) {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    return { ok: false, reason: 'clamp' };
  }
  const role = point && point.role ? getRole(point.role) : undefined;
  if (role) {
    /** @type {{ enumValues?: unknown[], airflowMax?: number }} */
    const limits = {};
    if (role.unit === 'enum' || role.unit === 'bool_or_enum') limits.enumValues = [value];
    const clamped = valueInClamp(role, value, limits);
    if (!clamped.ok) return clamped;
  }
  if (probe) {
    const runtime = confirmRuntime(point, probe);
    if (!runtime.ok) return runtime;
  }
  return { ok: true };
}

module.exports = { guardWrite };
