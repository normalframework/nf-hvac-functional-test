'use strict';

const READ_ROLES = [
  'discharge_air_temperature',
  'mixed_air_temperature',
  'return_air_temperature',
  'outdoor_air_intake_temperature',
  'discharge_air_static_pressure',
  'supply_fan_operating_status',
];

const WRITE_ROLES = [
  'outdoor_air_intake_damper_position_command',
  'cooling_valve_position_command',
  'heating_valve_position_command',
];

/**
 * @param {number} n
 */
function uuid(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/**
 * @param {number} n
 * @param {Record<string, unknown>} [extra]
 */
function point(n, extra) {
  return Object.assign({ uuid: uuid(n), layer: 'hpl:bacnet:1' }, extra);
}

/**
 * @typedef {object} SiteInput
 * @property {number} version
 * @property {Record<string, any>} [write]
 * @property {Record<string, any>} [plan]
 * @property {Record<string, any>} [vav_test]
 * @property {Record<string, any>} [interlocks]
 * @property {Record<string, any>} [limits]
 * @property {{ id: string, type: string, points: Record<string, any>, serves?: string[] }[]} equipment
 */

/**
 * Minimal valid input for the default per_point plan.
 * @returns {SiteInput}
 */
function minimalInput() {
  /** @type {Record<string, unknown>} */
  const points = {};
  let n = 1;
  for (const role of READ_ROLES) points[role] = point(n++);
  for (const role of WRITE_ROLES) points[role] = point(n++, { writable: true });
  return {
    version: 1,
    equipment: [{ id: 'ahu_a', type: 'ahu', points }],
  };
}

module.exports = { uuid, point, minimalInput, READ_ROLES, WRITE_ROLES };
