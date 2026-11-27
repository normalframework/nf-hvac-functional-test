'use strict';

const { DeviceObject } = require('./device');

/**
 * Plausibility-only AHU. Mixed air follows the outside-air fraction.
 * Supply air adds fan heat and coil effect. Faults are injected, not diagnosed.
 * @param {Map<string, DeviceObject>} points
 * @param {object} spec
 */
function seedAhu(points, spec) {
  const layer = spec.layer || 'hpl:bacnet:1';
  const ids = spec.points;
  /** @type {Record<string, DeviceObject>} */
  const byRole = {};

  /**
   * @param {string} role
   * @param {'ao'|'ai'|'bo'|'bi'|'mv'} type
   * @param {number | boolean | null} relinquish
   * @param {string} unit
   */
  function add(role, type, relinquish, unit) {
    const uuid = ids[role];
    if (!uuid) return;
    const object = new DeviceObject({ uuid, layer, type, relinquish, unit, role });
    points.set(uuid, object);
    byRole[role] = object;
  }

  add('outdoor_air_intake_temperature', 'ai', spec.oat ?? 12, 'degC');
  add('return_air_temperature', 'ai', spec.rat ?? 22, 'degC');
  add('mixed_air_temperature', 'ai', 18, 'degC');
  add('discharge_air_temperature', 'ai', 18, 'degC');
  add('outdoor_air_intake_relative_humidity', 'ai', spec.rh ?? 40, '%');
  add('discharge_air_static_pressure', 'ai', spec.staticPa ?? 250, 'Pa');
  add('supply_fan_operating_status', 'bi', spec.fanOn !== false, 'bool');
  add('outdoor_air_intake_damper_position_command', 'ao', 20, '%');
  add('return_damper_position_command', 'ao', 80, '%');
  add('cooling_valve_position_command', 'ao', 0, '%');
  add('heating_valve_position_command', 'ao', 0, '%');
  add('outdoor_air_intake_damper_position', 'ai', 20, '%');
  add('test_operating_mode_command', 'mv', 0, 'enum');

  const faults = spec.faults || {};
  if (byRole.mixed_air_temperature) {
    byRole.mixed_air_temperature.derive = () => mix(byRole, faults).mat;
  }
  if (byRole.discharge_air_temperature) {
    byRole.discharge_air_temperature.derive = () => {
      const state = mix(byRole, faults);
      let supply = state.mat + state.fanHeat + state.heat - state.cool;
      if (typeof faults.biasSupply === 'number') supply += faults.biasSupply;
      return supply;
    };
  }
  if (byRole.outdoor_air_intake_damper_position && byRole.outdoor_air_intake_damper_position_command) {
    byRole.outdoor_air_intake_damper_position.derive = () => {
      if (typeof faults.stuckDamper === 'number') return faults.stuckDamper;
      return Number(byRole.outdoor_air_intake_damper_position_command.presentValue());
    };
  }
  return byRole;
}

/**
 * @param {Record<string, DeviceObject>} byRole
 * @param {any} faults
 */
function mix(byRole, faults) {
  const outside = Number(byRole.outdoor_air_intake_temperature ? byRole.outdoor_air_intake_temperature.presentValue() : 12);
  const returned = Number(byRole.return_air_temperature ? byRole.return_air_temperature.presentValue() : 22);
  let fraction = byRole.outdoor_air_intake_damper_position_command
    ? Number(byRole.outdoor_air_intake_damper_position_command.presentValue()) / 100
    : 0.2;
  if (typeof faults.stuckDamper === 'number') fraction = faults.stuckDamper / 100;
  if (typeof faults.leakDamper === 'number') fraction = Math.max(fraction, faults.leakDamper);
  fraction = Math.min(1, Math.max(0, fraction));
  const cool = byRole.cooling_valve_position_command ? Number(byRole.cooling_valve_position_command.presentValue()) / 100 : 0;
  const heat = byRole.heating_valve_position_command ? Number(byRole.heating_valve_position_command.presentValue()) / 100 : 0;
  let coolEffect = cool * 8;
  if (typeof faults.leakCool === 'number') coolEffect = Math.max(coolEffect, faults.leakCool);
  const fanOn = byRole.supply_fan_operating_status ? Boolean(byRole.supply_fan_operating_status.presentValue()) : true;
  return {
    mat: outside * fraction + returned * (1 - fraction),
    fanHeat: fanOn ? 1.2 : 0,
    cool: coolEffect,
    heat: heat * 10,
  };
}

module.exports = { seedAhu };
