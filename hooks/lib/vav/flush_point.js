'use strict';

/**
 * @param {{ flush: number | boolean, readback: number | boolean | null }} spec
 */
function flushEffective(spec) {
  if (spec.readback !== spec.flush) return { ok: false, reason: 'write_not_effective' };
  return { ok: true, reason: null };
}

module.exports = { flushEffective };
