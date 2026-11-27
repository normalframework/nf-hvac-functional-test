'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', '..', 'vendor', 'roles', 'openfdd-roles.json');
const PIN_FILE = path.join(__dirname, '..', '..', '..', 'schema', 'openfdd-roles.pin.json');
const PIN = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')).sha256;

const WIRE = {
  'unit:DEG_C': 'DEG_C',
  'unit:PA': 'PA',
  'unit:PERCENT': 'PERCENT',
  'unit:PERCENT_RH': 'PERCENT_RH',
  'unit:L-PER-SEC': 'L-PER-SEC',
  'unit:KiloW': 'KiloW',
};

const CLAMP = {
  DEG_C: { min: -50, max: 80 },
  PA: { min: -500, max: 5000 },
  PERCENT: { min: 0, max: 100 },
  PERCENT_RH: { min: 0, max: 100 },
  'L-PER-SEC': { min: 0, max: 100000 },
  KiloW: { min: 0, max: 100000 },
};

/** App policy. The vocabulary says who may write. It does not say which reads a plan requires. */
const REQUIREMENT = {
  discharge_air_temperature: 'yes',
  mixed_air_temperature: 'yes',
  return_air_temperature: 'yes',
  outdoor_air_intake_temperature: 'yes',
  discharge_air_static_pressure: 'yes',
  supply_fan_operating_status: 'yes',
  outdoor_air_intake_damper_position_command: 'per_strategy',
  cooling_valve_position_command: 'per_strategy',
  heating_valve_position_command: 'per_strategy',
  test_operating_mode_command: 'mode_point',
  air_temperature_low_limit_alarm_status: 'recommended',
  air_smoke_alarm_status: 'recommended',
  maximum_cooling_operating_mode_command: 'bas_toggle',
};

/**
 * @param {string[]} applies
 * @returns {Array<'ahu' | 'vav'>}
 */
function equipmentOf(applies) {
  /** @type {Set<'ahu' | 'vav'>} */
  const kinds = new Set();
  for (const iri of applies || []) {
    if (/Zone|DomainSpace|Terminal|SingleDuct|FanPowered/.test(iri)) kinds.add('vav');
    else kinds.add('ahu');
  }
  if (kinds.size === 0) kinds.add('ahu');
  return [...kinds];
}

function loadVocabulary() {
  const bytes = fs.readFileSync(FILE);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== PIN) {
    const error = new Error('Vendored openfdd-roles.json sha256 does not match the pin');
    /** @type {any} */ (error).code = 'role_file_hash_mismatch';
    throw error;
  }
  return JSON.parse(bytes.toString('utf8'));
}

/**
 * @param {any} doc
 */
function functionalEntries(doc) {
  return (doc.roles || []).filter((entry) => entry.consumers && entry.consumers['nf-hvac-functional-test']);
}

/**
 * @param {any} entry
 * @param {string} direction
 */
function toRole(entry, direction) {
  const wire = WIRE[entry.unit] || null;
  let unit = wire || 'bool';
  if (!wire && entry.value_type === 'enumeration') unit = 'enum';
  if (!wire && entry.value_type === 'boolean') unit = 'bool';
  const equipment = equipmentOf((entry.s223 && entry.s223.applies_to) || []);
  const requirement = REQUIREMENT[entry.role] || 'no';
  return {
    id: entry.role,
    equipment: equipment.length === 1 ? equipment[0] : equipment,
    direction,
    unit,
    requirement,
    ftest: direction !== 'read' || requirement === 'recommended' || entry.role === 'discharge_air_volume_flow_rate_maximum',
    clamp: CLAMP[unit] || null,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
  };
}

function functionalRoles(doc = loadVocabulary()) {
  return functionalEntries(doc).map((entry) => toRole(entry, entry.consumers['nf-hvac-functional-test']));
}

/**
 * Haystack tags are the binding. The role id is the 223P name.
 * @param {any} [doc]
 */
function haystackProjection(doc = loadVocabulary()) {
  return {
    version: doc.version,
    source: 'vendor/roles/openfdd-roles.json',
    writable_markers: ['writable'],
    equipment_tags: { ahu: ['ahu'], vav: ['vav'] },
    relationship_tags: ['ahuRef', 'airRef', 'equipRef'],
    roles: functionalEntries(doc).map((entry) => {
      const haystack = entry.haystack || {};
      return {
        role: entry.role,
        tags: [...(haystack.markers || []), ...(haystack.custom_markers || [])],
        forbid: haystack.forbid || [],
      };
    }),
  };
}

module.exports = {
  PIN,
  FILE,
  loadVocabulary,
  functionalRoles,
  haystackProjection,
};
