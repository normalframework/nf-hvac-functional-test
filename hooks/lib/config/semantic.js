'use strict';

const { getRole, listRoles, roleAllowsWrite, roleFitsEquipment } = require('../roles');
const { checkPriority } = require('./priority');
const { AHU_CONDITIONING_STEPS, CATALOG_STEP_IDS } = require('./defaults');

const CATALOG = new Set(CATALOG_STEP_IDS);

/**
 * @param {string} code
 * @param {string} issuePath
 * @param {string} message
 */
function issue(code, issuePath, message) {
  return { code, path: issuePath, message };
}

/**
 * @param {any} config
 * @returns {{ code: string, path: string, message: string }[]}
 */
function semanticIssues(config) {
  /** @type {{ code: string, path: string, message: string }[]} */
  const errors = [];

  const priority = checkPriority(config.write.bacnet_priority);
  if (!priority.ok) {
    errors.push(issue(priority.code, 'write.bacnet_priority', priority.message));
  }
  if (config.write.keepalive_s >= config.write.command_lease_s) {
    errors.push(issue('lease', 'write.keepalive_s', 'keepalive_s must be less than command_lease_s'));
  }
  if (config.write.release_backoff_s.length < config.write.release_retries) {
    errors.push(issue('backoff', 'write.release_backoff_s', 'release_backoff_s must have at least release_retries entries'));
  }
  if (config.plan.econ_window.low_c >= config.plan.econ_window.high_c) {
    errors.push(issue('econ_window', 'plan.econ_window', 'econ_window low_c must be below high_c'));
  }
  if (config.interlocks.zone_air_temperature_min_c >= config.interlocks.zone_air_temperature_max_c) {
    errors.push(issue('zone_band', 'interlocks', 'zone_air_temperature_min_c must be below zone_air_temperature_max_c'));
  }
  if (config.vav_test.batch_size > config.limits.max_boxes_overridden) {
    errors.push(issue('batch_size', 'vav_test.batch_size', 'batch_size must not exceed max_boxes_overridden'));
  }
  if (typeof config.vav_test.airflow_setpoint_hard_cap_m3s === 'number' && config.vav_test.airflow_setpoint_hard_cap_m3s <= 0) {
    errors.push(issue('airflow_cap', 'vav_test.airflow_setpoint_hard_cap_m3s', 'airflow_setpoint_hard_cap_m3s must be greater than 0'));
  }
  if (typeof config.vav_test.airflow_setpoint_default_m3s === 'number' && config.vav_test.airflow_setpoint_default_m3s < 0) {
    errors.push(issue('airflow_default', 'vav_test.airflow_setpoint_default_m3s', 'airflow_setpoint_default_m3s must be >= 0'));
  }

  const steps = config.plan.steps;
  const seenSteps = new Set();
  const enabled = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const id = step.step_id;
    if (seenSteps.has(id)) errors.push(issue('duplicate_step', `plan.steps.${i}.step_id`, `duplicate step ${id}`));
    seenSteps.add(id);
    if (step.enabled === true) {
      enabled.push(step);
      if (CATALOG.has(id)) {
        errors.push(issue('step_not_implemented', `plan.steps.${i}.step_id`, `${id} is catalogued for a later version and cannot be enabled in v0.1`));
      }
    }
    if (id === 'vav.max_cool' && step.enabled === true) {
      const hold = step.hold_minutes;
      if (typeof hold !== 'number' || hold < 5 || hold > 120) {
        errors.push(issue('vav_hold', `plan.steps.${i}.hold_minutes`, 'vav.max_cool hold_minutes must be from 5 to 120'));
      }
    }
  }

  const enabledIds = enabled.map((step) => step.step_id);
  const vavAt = enabledIds.indexOf('vav.max_cool');
  if (vavAt >= 0) {
    const prior = enabledIds.slice(0, vavAt);
    const hasConditioning = AHU_CONDITIONING_STEPS.some((id) => prior.includes(id));
    if (!hasConditioning) {
      errors.push(issue('vav_order', 'plan.steps', 'vav.max_cool must follow ahu.recirc or ahu.economizer'));
    }
  }
  const recoveryAt = enabledIds.indexOf('recovery');
  if (recoveryAt >= 0 && recoveryAt !== enabledIds.length - 1) {
    errors.push(issue('recovery_order', 'plan.steps', 'recovery must be the last enabled step'));
  }

  const writesConditioning = enabledIds.some((id) => AHU_CONDITIONING_STEPS.includes(id) || id === 'vav.max_cool');

  /** @type {Map<string, { type: string }>} */
  const byId = new Map();
  /** @type {Set<string>} */
  const uuids = new Set();

  if (!config.equipment.some((/** @type {{ type: string }} */ item) => item.type === 'ahu')) {
    errors.push(issue('equipment', 'equipment', 'at least one ahu is required'));
  }

  const seenEquipment = new Set();
  for (let i = 0; i < config.equipment.length; i += 1) {
    const item = config.equipment[i];
    if (seenEquipment.has(item.id)) {
      errors.push(issue('duplicate_equipment', `equipment.${i}.id`, `duplicate equipment id ${item.id}`));
    }
    seenEquipment.add(item.id);
    byId.set(item.id, item);
  }

  for (let i = 0; i < config.equipment.length; i += 1) {
    const item = config.equipment[i];
    const points = item.points || {};
    for (const [roleId, binding] of Object.entries(points)) {
      const role = getRole(roleId);
      const path = `equipment.${i}.points.${roleId}`;
      if (!role) {
        errors.push(issue('unknown_role', path, `unknown role ${roleId}`));
        continue;
      }
      if (!roleFitsEquipment(role, item.type)) {
        const where = Array.isArray(role.equipment) ? role.equipment.join(' or ') : role.equipment;
        errors.push(issue('role_equipment', path, `${roleId} belongs on ${where}, not ${item.type}`));
      }
      const hasUuid = typeof binding.uuid === 'string';
      const hasQuery = Boolean(binding.query) && typeof binding.query === 'object';
      if (hasUuid === hasQuery) {
        errors.push(issue('binding_shape', path, `${roleId} needs a uuid or a query, not both`));
      } else if (hasUuid && typeof binding.layer !== 'string') {
        errors.push(issue('binding_shape', path, `${roleId} uuid binding needs a layer`));
      }
      if (binding.writable === true && !roleAllowsWrite(role)) {
        errors.push(issue('writable_not_allowed', path, `${roleId} is not a write role`));
      }
      if (typeof binding.uuid === 'string') {
        if (uuids.has(binding.uuid)) errors.push(issue('duplicate_uuid', path, `duplicate point uuid ${binding.uuid}`));
        uuids.add(binding.uuid);
      }
    }
    if (item.type === 'ahu') {
      checkAhuRoles(item, i, errors);
    }
    if (item.serves) {
      if (item.type !== 'ahu') {
        errors.push(issue('serves', `equipment.${i}.serves`, 'only ahu equipment may list serves'));
      } else {
        for (const target of item.serves) {
          const found = byId.get(target);
          if (!found || found.type !== 'vav') {
            errors.push(issue('serves', `equipment.${i}.serves`, `serves entry ${target} is not a vav in this config`));
          }
        }
      }
    }
  }

  if (config.plan.ahu_strategy === 'mode_point' && writesConditioning) {
    for (const stepId of AHU_CONDITIONING_STEPS) {
      if (!enabledIds.includes(stepId)) continue;
      if (!Object.prototype.hasOwnProperty.call(config.plan.mode_point_values, stepId)) {
        errors.push(issue('mode_point_values', 'plan.mode_point_values', `mode_point_values missing ${stepId}`));
      }
    }
  }

  return errors;
}

/**
 * Required sensor roles only. Which writes can run is decided by the model
 * planner, not by a fixed per-site point list.
 * @param {any} item
 * @param {number} index
 * @param {{ code: string, path: string, message: string }[]} errors
 */
function checkAhuRoles(item, index, errors) {
  const points = item.points || {};
  for (const role of listRoles()) {
    if (role.equipment !== 'ahu' || role.requirement !== 'yes') continue;
    if (points[role.id]) continue;
    errors.push(issue('role_unbound', `equipment.${index}.points.${role.id}`, `required role ${role.id} is not bound on ${item.id}`));
  }
}

module.exports = { semanticIssues };
