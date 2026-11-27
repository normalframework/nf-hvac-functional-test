'use strict';

/**
 * NF command lifetime, for example "300s". The command service does not read duration_s.
 * @param {number} seconds
 */
function formatDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error('duration must be a positive integer number of seconds');
  }
  return `${seconds}s`;
}

/**
 * @param {string} text
 * @returns {number} milliseconds, or NaN
 */
function parseDurationMs(text) {
  if (typeof text !== 'string') return NaN;
  const match = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!match) return NaN;
  const amount = Number(match[1]);
  if (match[2] === 'ms') return amount;
  if (match[2] === 's') return amount * 1000;
  if (match[2] === 'm') return amount * 60 * 1000;
  return amount * 60 * 60 * 1000;
}

module.exports = { formatDuration, parseDurationMs };
