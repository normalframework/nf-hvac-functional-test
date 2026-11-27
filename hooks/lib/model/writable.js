'use strict';

const { getRole, roleAllowsWrite } = require('../roles');

/**
 * A write is allowed only when the model marks the point writable.
 * An explicit config binding must also set writable true. A config flag
 * cannot promote a point the model marks read-only. Omitting the binding
 * (model discovery) leaves the model marker as the allow-list.
 * @param {{ role?: string, writable?: boolean } | null | undefined} modelPoint
 * @param {{ writable?: boolean } | null | undefined} configBinding
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function evaluateWrite(modelPoint, configBinding) {
  if (!modelPoint) return { ok: false, reason: 'role_unbound' };
  const role = modelPoint.role ? getRole(modelPoint.role) : undefined;
  if (role && !roleAllowsWrite(role)) return { ok: false, reason: 'role_not_writable' };
  if (modelPoint.writable !== true) return { ok: false, reason: 'model_not_writable' };
  if (configBinding && configBinding.writable !== true) return { ok: false, reason: 'not_on_allow_list' };
  return { ok: true };
}

/**
 * Runtime confirmation after the model has allowed a write.
 * A missing priority array or a failed readback skips the point.
 * This does not perform I/O; the caller supplies the probe.
 * @param {{ writable?: boolean } | null | undefined} modelPoint
 * @param {{ priority_array?: boolean, readback_ok?: boolean | null } | null | undefined} probe
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function confirmRuntime(modelPoint, probe) {
  if (!modelPoint || modelPoint.writable !== true) return { ok: false, reason: 'model_not_writable' };
  if (!probe || probe.priority_array !== true) return { ok: false, reason: 'no_priority_array' };
  if (probe.readback_ok === false) return { ok: false, reason: 'write_not_effective' };
  return { ok: true };
}

module.exports = { evaluateWrite, confirmRuntime };
