'use strict';

const { functionalRoles } = require('./model/vocabulary');

/**
 * @typedef {'read' | 'write' | 'readwrite'} Direction
 * @typedef {'yes' | 'no' | 'per_strategy' | 'mode_point' | 'bas_toggle' | 'recommended'} Requirement
 * @typedef {'ahu' | 'vav'} EquipmentType
 * @typedef {{ min: number, max: number }} NumericClamp
 * @typedef {object} RoleDef
 * @property {string} id
 * @property {EquipmentType | EquipmentType[]} equipment
 * @property {Direction} direction
 * @property {string} unit
 * @property {Requirement} requirement
 * @property {boolean} ftest
 * @property {NumericClamp | null} clamp
 * @property {string[]} aliases
 */

/** @type {RoleDef[]} */
const ROLE_LIST = functionalRoles();

/** @type {Map<string, RoleDef>} */
const BY_ID = new Map();
for (const role of ROLE_LIST) {
  BY_ID.set(role.id, Object.freeze(role));
  for (const alias of role.aliases) {
    if (!BY_ID.has(alias)) BY_ID.set(alias, Object.freeze(role));
  }
}

/**
 * @param {string} id
 * @returns {RoleDef | undefined}
 */
function getRole(id) {
  return BY_ID.get(id);
}

/** @returns {RoleDef[]} */
function listRoles() {
  return ROLE_LIST.map((role) => role);
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function isKnownRole(id) {
  return BY_ID.has(id);
}

/**
 * @param {RoleDef} role
 * @param {string} type
 */
function roleFitsEquipment(role, type) {
  if (Array.isArray(role.equipment)) return role.equipment.includes(/** @type {any} */ (type));
  return role.equipment === type;
}

/**
 * @param {RoleDef} role
 * @returns {boolean}
 */
function roleAllowsWrite(role) {
  return role.direction === 'write' || role.direction === 'readwrite';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isBoolish(value) {
  return typeof value === 'boolean' || value === 0 || value === 1;
}

/**
 * @param {RoleDef} role
 * @param {unknown} value
 * @param {{ airflowMax?: number | null, enumValues?: unknown[] }} [limits]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function valueInClamp(role, value, limits) {
  const cap = limits || {};
  if (role.unit === 'bool') {
    return isBoolish(value) ? { ok: true } : { ok: false, reason: 'clamp' };
  }
  if (role.unit === 'enum') {
    if (!Array.isArray(cap.enumValues) || !cap.enumValues.some((item) => item === value)) {
      return { ok: false, reason: 'enum' };
    }
    return { ok: true };
  }
  if (role.unit === 'bool_or_enum') {
    if (isBoolish(value)) return { ok: true };
    if (Array.isArray(cap.enumValues) && cap.enumValues.some((item) => item === value)) return { ok: true };
    return { ok: false, reason: 'enum' };
  }
  if (role.unit === 'bool_or_percent' && isBoolish(value)) return { ok: true };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: 'clamp' };
  }
  const clamp = role.clamp;
  if (!clamp) return { ok: false, reason: 'clamp' };
  let max = clamp.max;
  if (role.unit === 'L-PER-SEC' && typeof cap.airflowMax === 'number') {
    max = Math.min(max, cap.airflowMax);
  }
  if (value < clamp.min || value > max) return { ok: false, reason: 'clamp' };
  return { ok: true };
}

module.exports = {
  getRole,
  listRoles,
  isKnownRole,
  roleFitsEquipment,
  roleAllowsWrite,
  valueInClamp,
};
