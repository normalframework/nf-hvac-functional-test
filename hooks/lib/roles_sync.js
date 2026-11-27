'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PIN_FILE = path.join(__dirname, '..', '..', 'schema', 'openfdd-roles.pin.json');

/**
 * @param {string} [file]
 */
function readOpenfddPin(file = PIN_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The pin stays on a commit until the owner flips it to the release tag.
 * @param {any} pin
 */
function assertPinReady(pin) {
  if (!pin || pin.pinned_to_tag === true) {
    const error = new Error('Role pin is flipped to a tag. This checkout must stay on the commit SHA until v5.0.22 is tagged.');
    /** @type {any} */ (error).code = 'pin_flipped';
    throw error;
  }
  if (pin.pinned_to_tag !== false) {
    const error = new Error('pinned_to_tag must be false until the 5.0.22 tag is adopted');
    /** @type {any} */ (error).code = 'pin_shape';
    throw error;
  }
  const ref = pin.upstream && pin.upstream.ref;
  if (typeof ref !== 'string' || !/^[0-9a-f]{40}$/.test(ref)) {
    const error = new Error('upstream.ref must be the Open-FDD commit SHA while pinned_to_tag is false');
    /** @type {any} */ (error).code = 'pin_not_a_commit';
    throw error;
  }
  if (pin.intended_tag !== 'v5.0.22') {
    const error = new Error('intended_tag must stay v5.0.22 so the flip has one target');
    /** @type {any} */ (error).code = 'pin_tag';
    throw error;
  }
  return pin;
}

/**
 * @param {any} doc
 * @returns {string[]}
 */
function roleNames(doc) {
  return (doc.roles || []).map((entry) => entry.role).filter((name) => typeof name === 'string');
}

/**
 * @param {string[]} localNames
 * @param {string[]} upstreamNames
 */
function diffRoleNames(localNames, upstreamNames) {
  const local = new Set(localNames);
  const upstream = new Set(upstreamNames);
  const missing = [...upstream].filter((name) => !local.has(name)).sort();
  const extra = [...local].filter((name) => !upstream.has(name)).sort();
  return { missing, extra };
}

/**
 * @param {string[]} localNames
 * @param {string[]} upstreamNames
 */
function assertSameRoleNames(localNames, upstreamNames) {
  const diff = diffRoleNames(localNames, upstreamNames);
  if (diff.missing.length === 0 && diff.extra.length === 0 && localNames.length === upstreamNames.length) {
    return diff;
  }
  const error = new Error(`Open-FDD role names drifted. missing=${diff.missing.join(',') || '-'} extra=${diff.extra.join(',') || '-'}`);
  /** @type {any} */ (error).code = 'role_name_drift';
  /** @type {any} */ (error).diff = diff;
  throw error;
}

module.exports = {
  PIN_FILE,
  readOpenfddPin,
  assertPinReady,
  roleNames,
  diffRoleNames,
  assertSameRoleNames,
};
