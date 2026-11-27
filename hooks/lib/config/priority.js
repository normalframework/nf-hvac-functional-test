'use strict';

const PRIORITY_DEFAULT = 8;
const PRIORITY_MIN = 3;
const PRIORITY_MAX = 16;

/**
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function checkPriority(value) {
  if (value === 1 || value === 2) {
    return {
      ok: false,
      code: 'priority_rejected',
      message: 'BACnet priorities 1 and 2 are rejected',
    };
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < PRIORITY_MIN || value > PRIORITY_MAX) {
    return {
      ok: false,
      code: 'priority_out_of_range',
      message: 'BACnet priority must be an integer from 3 to 16',
    };
  }
  return { ok: true };
}

module.exports = {
  PRIORITY_DEFAULT,
  PRIORITY_MIN,
  PRIORITY_MAX,
  checkPriority,
};
