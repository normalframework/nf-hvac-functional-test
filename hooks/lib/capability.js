'use strict';

/**
 * @param {Array<number | null> | null} slots
 * @param {number} priority
 */
function assessPriority(slots, priority) {
  if (!Array.isArray(slots)) return { ok: false, reason: 'no_priority_array' };
  for (let index = 0; index < priority - 1; index += 1) {
    if (slots[index] !== null && slots[index] !== undefined) return { ok: false, reason: 'higher_priority_override' };
  }
  if (slots[priority - 1] !== null && slots[priority - 1] !== undefined) return { ok: false, reason: 'slot_occupied' };
  return { ok: true, reason: null };
}

/**
 * @param {{ oat: number | null, rat: number | null, rh: number | null }} readings
 * @param {{ low_c: number, high_c: number, min_delta_k: number, max_rh_pct: number }} window
 */
function economizerEligible(readings, window) {
  if (readings.oat === null || readings.rat === null) return false;
  if (readings.oat < window.low_c || readings.oat > window.high_c) return false;
  if (readings.rat - readings.oat < window.min_delta_k) return false;
  if (readings.rh !== null && readings.rh > window.max_rh_pct) return false;
  return true;
}

module.exports = { assessPriority, economizerEligible };
