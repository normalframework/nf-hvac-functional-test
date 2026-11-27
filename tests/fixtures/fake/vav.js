'use strict';

const { DeviceObject } = require('./device');

/**
 * @param {Map<string, import('./device').DeviceObject>} points
 * @param {object} spec
 */
function seedVav(points, spec) {
  const layer = spec.layer || 'hpl:bacnet:1';
  const profile = spec.profile;
  const max = spec.maxFlow ?? 0.5;
  const flow = new DeviceObject({
    uuid: spec.points.discharge_air_volume_flow_rate,
    layer,
    type: 'ai',
    relinquish: spec.flow ?? 0.1,
    unit: 'L/s',
    role: 'discharge_air_volume_flow_rate',
  });
  points.set(flow.uuid, flow);

  if (spec.points.discharge_air_volume_flow_rate_maximum) {
    const cap = new DeviceObject({
      uuid: spec.points.discharge_air_volume_flow_rate_maximum,
      layer,
      type: 'ai',
      relinquish: max,
      unit: 'L/s',
      role: 'discharge_air_volume_flow_rate_maximum',
    });
    points.set(cap.uuid, cap);
  }

  if (spec.points.zone_air_temperature) {
    const zone = new DeviceObject({
      uuid: spec.points.zone_air_temperature,
      layer,
      type: 'ai',
      relinquish: spec.zone ?? 22,
      unit: 'degC',
      role: 'zone_air_temperature',
    });
    points.set(zone.uuid, zone);
  }

  if (spec.points.purge_operating_mode_command && (profile === 'flush_capable' || profile === 'offline')) {
    const flush = new DeviceObject({
      uuid: spec.points.purge_operating_mode_command,
      layer,
      type: 'bo',
      relinquish: false,
      unit: 'bool',
      role: 'purge_operating_mode_command',
    });
    if (profile === 'offline') flush.offline = true;
    const original = flush.writeAt.bind(flush);
    flush.writeAt = (priority, value) => {
      const result = original(priority, value);
      if (value === true || value === 1) flow.presentOverride = max;
      return result;
    };
    points.set(flush.uuid, flush);
  }

  if (spec.points.discharge_air_volume_flow_rate_setpoint && profile !== 'flush_capable') {
    const setpoint = new DeviceObject({
      uuid: spec.points.discharge_air_volume_flow_rate_setpoint,
      layer,
      type: profile === 'setpoint_readonly' ? 'ai' : 'ao',
      relinquish: spec.flow ?? 0.1,
      unit: 'L/s',
      role: 'discharge_air_volume_flow_rate_setpoint',
    });
    if (profile === 'setpoint_ignored') setpoint.ignoreWrites = true;
    if (profile === 'offline') setpoint.offline = true;
    if (profile === 'higher_priority_override_active') setpoint.slots[7] = max;
    if (profile === 'setpoint_writable' || profile === 'setpoint_ignored') {
      const original = setpoint.writeAt.bind(setpoint);
      setpoint.writeAt = (priority, value) => {
        const result = original(priority, value);
        if (!setpoint.ignoreWrites && value !== null) flow.presentOverride = value;
        return result;
      };
    }
    points.set(setpoint.uuid, setpoint);
  }

  if (profile === 'offline' && spec.points.discharge_air_volume_flow_rate) flow.offline = true;
  return { id: spec.id, profile };
}

module.exports = { seedVav };
