'use strict';

const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Crockford base32 ULID. Time is millisecond-sortable. Randomness is 80 bits.
 * @param {number} [now]
 */
function ulid(now = Date.now()) {
  let time = Math.max(0, Math.floor(now));
  let prefix = '';
  for (let i = 0; i < 10; i += 1) {
    prefix = ALPHABET[time % 32] + prefix;
    time = Math.floor(time / 32);
  }
  const bytes = crypto.randomBytes(10);
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let random = '';
  for (let i = 0; i < 16; i += 1) {
    random = ALPHABET[Number(value & 31n)] + random;
    value >>= 5n;
  }
  return prefix + random;
}

/**
 * @param {string} value
 */
function isUlid(value) {
  return typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

module.exports = { ulid, isUlid };
