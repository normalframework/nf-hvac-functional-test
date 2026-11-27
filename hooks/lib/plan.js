'use strict';

const { applyDefaults } = require('./config/defaults');
const { evaluateWrite } = require('./model/writable');

const REQUIRED_AHU_READS = [
  'discharge_air_temperature',
  'mixed_air_temperature',
  'return_air_temperature',
  'outdoor_air_intake_temperature',
  'discharge_air_static_pressure',
  'supply_fan_operating_status',
];

const RECIRC_WRITES = [
  { role: 'outdoor_air_intake_damper_position_command', value: 0, required: false },
  { role: 'return_damper_position_command', value: 100, required: false },
  { role: 'cooling_valve_position_command', value: 0, required: true },
  { role: 'heating_valve_position_command', value: 0, required: true },
];

const ECONOMIZER_WRITES = [
  { role: 'outdoor_air_intake_damper_position_command', value: 100, required: true },
  { role: 'return_damper_position_command', value: 0, required: false },
  { role: 'cooling_valve_position_command', value: 0, required: true },
  { role: 'heating_valve_position_command', value: 0, required: true },
];

/**
 * @param {any} equipment
 * @param {string} role
 */
function findPoint(equipment, role) {
  if (!equipment || !equipment.points) return null;
  return equipment.points[role] || null;
}

/**
 * @param {any} config
 * @param {string} equipmentId
 * @param {string} role
 */
function findBinding(config, equipmentId, role) {
  const match = (config.equipment || []).find((item) => item.id === equipmentId);
  if (!match || !match.points) return undefined;
  return match.points[role];
}

/**
 * @param {any} model
 * @param {any} config
 */
function selectAhu(model, config) {
  const ahus = model.equipment.filter((item) => item.type === 'ahu');
  const requested = (config.equipment || []).find((item) => item.type === 'ahu');
  if (requested) return ahus.find((item) => item.id === requested.id) || null;
  if (ahus.length === 1) return ahus[0];
  return null;
}

/**
 * @param {any} model
 * @param {any} ahu
 */
function servedBoxes(model, ahu) {
  const ids = new Set(ahu.serves || []);
  for (const item of model.equipment) {
    if (item.ahuRef === ahu.id) ids.add(item.id);
  }
  return model.equipment
    .filter((item) => item.type === 'vav' && ids.has(item.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @param {any} ahu
 * @param {any} config
 * @param {{ role: string, value: number, required: boolean }[]} spec
 * @param {string} stepId
 * @returns {any}
 */
function resolveWrites(ahu, config, spec, stepId) {
  if (config.plan.ahu_strategy === 'mode_point') {
    const role = 'test_operating_mode_command';
    const point = findPoint(ahu, role);
    const gate = evaluateWrite(point, findBinding(config, ahu.id, role));
    if (!gate.ok) return { ok: false, reason: `${gate.reason}:${role}`, writes: [] };
    const value = config.plan.mode_point_values[stepId];
    return { ok: true, writes: [{ role, value, equipment_id: ahu.id }] };
  }
  /** @type {{ role: string, value: number, equipment_id: string }[]} */
  const writes = [];
  for (const item of spec) {
    const point = findPoint(ahu, item.role);
    const gate = evaluateWrite(point, findBinding(config, ahu.id, item.role));
    if (!gate.ok) {
      if (item.required) return { ok: false, reason: `${gate.reason}:${item.role}`, writes: [] };
      continue;
    }
    writes.push({ role: item.role, value: item.value, equipment_id: ahu.id });
  }
  return { ok: true, writes };
}

/**
 * @param {any} box
 * @param {any} ahu
 * @param {any} config
 * @param {string[]} order
 */
function strategyForBox(box, ahu, config, order) {
  /** @type {{ strategy: string | null, reason: string | null }} */
  let fallback = { strategy: null, reason: 'role_unbound:purge_operating_mode_command' };
  for (const strategy of order) {
    const role = strategy === 'flush_point'
      ? 'purge_operating_mode_command'
      : strategy === 'airflow_setpoint'
        ? 'discharge_air_volume_flow_rate_setpoint'
        : 'maximum_cooling_operating_mode_command';
    const owner = strategy === 'bas_toggle' ? ahu : box;
    const gate = evaluateWrite(findPoint(owner, role), findBinding(config, owner.id, role));
    if (gate.ok) return { strategy, reason: null };
    fallback = { strategy: null, reason: `${gate.reason}:${role}` };
  }
  return fallback;
}

/**
 * @param {any} ahu
 * @param {any[]} boxes
 * @param {any} config
 */
function planVav(ahu, boxes, config) {
  const setting = config.vav_test.strategy;
  /** @type {string[]} */
  let order;
  if (setting === 'auto') order = ['bas_toggle', 'flush_point', 'airflow_setpoint'];
  else if (setting === 'auto_per_box') order = config.vav_test.per_box_strategy.slice();
  else order = [setting];

  if (setting === 'bas_toggle') {
    const gate = evaluateWrite(
      findPoint(ahu, 'maximum_cooling_operating_mode_command'),
      findBinding(config, ahu.id, 'maximum_cooling_operating_mode_command'),
    );
    if (!gate.ok) {
      return {
        status: 'skipped',
        skip_reason: `${gate.reason}:maximum_cooling_operating_mode_command`,
        per_box: boxes.map((box) => ({ equipment_id: box.id, strategy: null, reason: `${gate.reason}:maximum_cooling_operating_mode_command` })),
      };
    }
    return {
      status: 'included',
      skip_reason: null,
      per_box: boxes.map((box) => ({ equipment_id: box.id, strategy: 'bas_toggle', reason: null })),
    };
  }

  /** @type {{ equipment_id: string, strategy: string | null, reason: string | null }[]} */
  const capable = [];
  /** @type {{ equipment_id: string, strategy: string | null, reason: string | null }[]} */
  const incapable = [];
  for (const box of boxes) {
    const chosen = strategyForBox(box, ahu, config, order);
    const row = { equipment_id: box.id, strategy: chosen.strategy, reason: chosen.reason };
    if (chosen.strategy) capable.push(row);
    else incapable.push(row);
  }
  /** @type {{ equipment_id: string, strategy: string | null, reason: string | null }[]} */
  const kept = [];
  /** @type {{ equipment_id: string, strategy: string | null, reason: string | null }[]} */
  const limited = [];
  for (const box of capable) {
    if (kept.length >= config.limits.max_boxes_overridden) {
      limited.push({ equipment_id: box.equipment_id, strategy: null, reason: 'over_box_limit' });
    } else {
      kept.push(box);
    }
  }
  const perBox = boxes.map((box) => {
    return kept.find((item) => item.equipment_id === box.id)
      || limited.find((item) => item.equipment_id === box.id)
      || incapable.find((item) => item.equipment_id === box.id)
      || { equipment_id: box.id, strategy: null, reason: 'role_unbound:purge_operating_mode_command' };
  });
  if (kept.length < config.vav_test.min_capable_boxes) {
    return { status: 'skipped', skip_reason: 'insufficient_capability', per_box: perBox };
  }
  return { status: 'included', skip_reason: null, per_box: perBox };
}

/**
 * @param {any} ahu
 * @param {any[]} boxes
 * @param {any} config
 */
function activeInterlocks(ahu, boxes, config) {
  /** @type {string[]} */
  const codes = [];
  if (findPoint(ahu, 'discharge_air_static_pressure')) codes.push('duct_static_high');
  if (findPoint(ahu, 'mixed_air_temperature')) codes.push('mixed_air_low');
  if (findPoint(ahu, 'discharge_air_temperature')) codes.push('discharge_air_low');
  if (findPoint(ahu, 'supply_fan_operating_status') && config.interlocks.fan_status_loss_abort) codes.push('fan_status_lost');
  if (findPoint(ahu, 'air_temperature_low_limit_alarm_status') && config.interlocks.freeze_protection_status_abort) codes.push('freeze_protection');
  if (findPoint(ahu, 'air_smoke_alarm_status') && config.interlocks.smoke_alarm_status_abort) codes.push('smoke_alarm');
  if (boxes.some((box) => findPoint(box, 'zone_air_temperature'))) codes.push('zone_out_of_band');
  if (codes.length > 0) codes.push('stale_data');
  codes.push('override_conflict');
  return codes;
}

/**
 * @param {any} ahu
 * @param {any[]} boxes
 */
function samplePoints(ahu, boxes) {
  /** @type {{ equipment_id: string, role: string, uuid: string | null, layer: string | null }[]} */
  const points = [];
  for (const item of [ahu, ...boxes]) {
    for (const point of Object.values(item.points || {})) {
      const typed = /** @type {{ role: string, uuid: string | null, layer: string | null }} */ (point);
      points.push({ equipment_id: item.id, role: typed.role, uuid: typed.uuid, layer: typed.layer });
    }
  }
  return points;
}

/**
 * Pure plan: internal model plus site policy. No per-box or per-site branches.
 * @param {any} model
 * @param {any} configInput
 * @returns {any}
 */
function buildPlan(model, configInput) {
  const config = applyDefaults(configInput || { version: 1 });
  const ahu = selectAhu(model, config);
  if (!ahu) {
    return {
      ready: false,
      reason: 'ahu_not_selected',
      equipment_id: null,
      steps: [],
      capability: null,
      interlocks: [],
      sample_points: [],
    };
  }
  const boxes = servedBoxes(model, ahu);
  const missingReads = REQUIRED_AHU_READS.filter((role) => !findPoint(ahu, role));
  /** @type {any[]} */
  const steps = [];
  let anyIncluded = false;

  for (const step of config.plan.steps) {
    if (step.enabled === false) {
      steps.push({ step_id: step.step_id, status: 'skipped', skip_reason: 'disabled', writes: [] });
      continue;
    }
    if (missingReads.length > 0 && step.step_id !== 'recovery') {
      steps.push({
        step_id: step.step_id,
        status: 'skipped',
        skip_reason: `role_unbound:${missingReads[0]}`,
        writes: [],
      });
      continue;
    }
    if (step.step_id === 'ahu.baseline' || step.step_id === 'recovery') {
      steps.push({ step_id: step.step_id, status: 'included', skip_reason: null, writes: [] });
      if (step.step_id === 'ahu.baseline') anyIncluded = true;
      continue;
    }
    if (step.step_id === 'ahu.recirc' || step.step_id === 'ahu.economizer') {
      const spec = step.step_id === 'ahu.recirc' ? RECIRC_WRITES : ECONOMIZER_WRITES;
      const resolved = resolveWrites(ahu, config, spec, step.step_id);
      if (!resolved.ok) {
        const reason = step.step_id === 'ahu.economizer' && resolved.reason.includes('outdoor_air_intake_damper_position_command')
          ? `economizer_points_missing:${resolved.reason}`
          : resolved.reason;
        steps.push({ step_id: step.step_id, status: 'skipped', skip_reason: reason, writes: [] });
        continue;
      }
      steps.push({
        step_id: step.step_id,
        status: 'included',
        skip_reason: null,
        writes: resolved.writes,
        preconditions: step.step_id === 'ahu.economizer' ? ['econ_window'] : [],
      });
      anyIncluded = true;
      continue;
    }
    if (step.step_id === 'vav.max_cool') {
      const vav = planVav(ahu, boxes, config);
      if (vav.status !== 'included') {
        steps.push({ step_id: step.step_id, status: 'skipped', skip_reason: vav.skip_reason, writes: [], boxes: vav.per_box });
        continue;
      }
      steps.push({ step_id: step.step_id, status: 'included', skip_reason: null, writes: [], boxes: vav.per_box });
      anyIncluded = true;
      continue;
    }
    steps.push({ step_id: step.step_id, status: 'skipped', skip_reason: 'step_not_implemented', writes: [] });
  }

  if (!anyIncluded) {
    for (const step of steps) {
      if (step.step_id === 'recovery' && step.status === 'included') {
        step.status = 'skipped';
        step.skip_reason = 'nothing_to_run';
      }
    }
  }

  const vavStep = steps.find((step) => step.step_id === 'vav.max_cool');
  const perBox = vavStep && vavStep.boxes ? vavStep.boxes : [];
  return {
    ready: missingReads.length === 0 && anyIncluded,
    reason: missingReads.length > 0 ? `role_unbound:${missingReads[0]}` : null,
    equipment_id: ahu.id,
    steps,
    capability: {
      ahu: {
        strategy: config.plan.ahu_strategy,
        steps: Object.fromEntries(steps.filter((step) => step.step_id.startsWith('ahu.')).map((step) => [step.step_id, step.status])),
      },
      vav: {
        strategy: config.vav_test.strategy,
        boxes_total: boxes.length,
        boxes_capable: perBox.filter((box) => box.strategy).length,
        boxes_skipped: perBox.filter((box) => !box.strategy).map((box) => ({ equipment_id: box.equipment_id, reason: box.reason })),
        per_box: perBox,
      },
    },
    interlocks: activeInterlocks(ahu, boxes, config),
    sample_points: samplePoints(ahu, boxes),
  };
}

module.exports = { buildPlan };
