'use strict';

const { RdfInputDisabledError } = require('./errors');
const { haystackProjection } = require('./vocabulary');

/** @returns {any} */
function loadHaystackMap() {
  return haystackProjection();
}

/** @returns {never} */
function loadRdfMap() {
  throw new RdfInputDisabledError();
}

/**
 * Overlay a site map on the shipped map. Entries are keyed by role plus tag
 * or type list, so a site can add a tag set without editing code.
 * @param {any} base
 * @param {any} extra
 */
function mergeMaps(base, extra) {
  if (!extra) return base;
  const roles = new Map();
  for (const entry of base.roles || []) roles.set(entryKey(entry), entry);
  for (const entry of extra.roles || []) roles.set(entryKey(entry), entry);
  return {
    ...base,
    ...extra,
    roles: [...roles.values()],
    version: extra.version || base.version,
  };
}

/**
 * @param {any} entry
 */
function entryKey(entry) {
  if (Array.isArray(entry.tags)) return `${entry.role}|tags:${entry.tags.join(',')}`;
  if (Array.isArray(entry.types)) return `${entry.role}|types:${entry.types.join(',')}`;
  return entry.role;
}

module.exports = {
  loadHaystackMap,
  loadRdfMap,
  mergeMaps,
};
