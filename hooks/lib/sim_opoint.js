'use strict';

/**
 * Extra bench points for the Operating point tab: pump speed, flow, DP, DP setpoint and kW for two chilled water
 * pumps and the hot water pump, plus fan speed feedback, static setpoint, airflow and kW for AHU-1. Code-defined, so the
 * demo fixture is untouched. chw-pump-2 is a deliberately incomplete standby pump (no speed, flow or DP point, no
 * nameplate) and AHU-2 gets no new points, so the tab shows its "Missing data" text. Simulated points only.
 */

const pt = (/** @type {string} */ equip, /** @type {string} */ suffix, /** @type {string} */ dis, /** @type {string} */ markers, /** @type {string} */ unit, /** @type {number|boolean} */ initial) => ({
  sourceId: `${equip}.${suffix}`, equip, dis, markers: `point,his,${markers}`, unit, kind: typeof initial === 'boolean' ? 'Bool' : 'Number', initial,
});

const PUMP_NAMEPLATE = {
  'chw-pump-1': { designFlow: '16 L/s', designHead: '180 kPa', designPower: '4.5 kW', ratedHz: '60' },
  'hw-pump-1': { designFlow: '8 L/s', designHead: '120 kPa', designPower: '1.5 kW', ratedHz: '60' },
};

/** Nameplate attributes added to existing or new equipment, by demo id. */
const EQUIPMENT_ATTRS = {
  ...PUMP_NAMEPLATE,
  'ahu-1': { designFlow: '1200 L/s', designPressure: '500 Pa', designPower: '4 kW', ratedHz: '60' },
};

const EXTRA_EQUIPMENT = [
  { id: 'chw-pump-1', dis: 'CHW Pump-1', markers: 'equip,pump,chilled,water', kind: 'pump' },
  { id: 'chw-pump-2', dis: 'CHW Pump-2 (standby)', markers: 'equip,pump,chilled,water', kind: 'pump' },
];

const waterPump = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string[]} */ water, /** @type {number} */ sp) => [
  pt(id, 'speed', `${name} speed`, 'pump,speed,sensor', '%', 0),
  pt(id, 'flow', `${name} ${water.join(' ')} flow`, `${water.join(',')},flow,sensor`, 'L/s', 0),
  pt(id, 'dp', `${name} loop differential pressure`, `${water.join(',')},delta,pressure,sensor`, 'kPa', sp),
  pt(id, 'dp-sp', `${name} loop differential pressure setpoint`, `${water.join(',')},delta,pressure,sp`, 'kPa', sp),
  pt(id, 'kw', `${name} electric power`, 'pump,elec,power,sensor', 'kW', 0),
];

const EXTRA_POINTS = [
  pt('chw-pump-1', 'run', 'CHW Pump-1 run status', 'pump,run,sensor', '', true),
  ...waterPump('chw-pump-1', 'CHW Pump-1', ['chilled', 'water'], 80),
  // Standby pump: only the setpoint, power and run points exist. Speed, flow and DP are deliberately missing.
  pt('chw-pump-2', 'run', 'CHW Pump-2 run status', 'pump,run,sensor', '', false),
  pt('chw-pump-2', 'dp-sp', 'CHW Pump-2 loop differential pressure setpoint', 'chilled,water,delta,pressure,sp', 'kPa', 80),
  pt('chw-pump-2', 'kw', 'CHW Pump-2 electric power', 'pump,elec,power,sensor', 'kW', 0),
  ...waterPump('hw-pump-1', 'HW Pump-1', ['hot', 'water'], 35),
  pt('ahu-1', 'sf-speed-fb', 'AHU-1 supply fan speed feedback', 'discharge,fan,vfd,speed,sensor', '%', 70),
  pt('ahu-1', 'dsp-sp', 'AHU-1 duct static pressure setpoint', 'discharge,air,pressure,sp', 'Pa', 120),
  pt('ahu-1', 'flow', 'AHU-1 supply airflow', 'discharge,air,flow,sensor', 'L/s', 840),
  pt('ahu-1', 'sf-kw', 'AHU-1 supply fan electric power', 'discharge,fan,elec,power,sensor', 'kW', 1.4),
];

const clamp01 = (/** @type {number} */ v) => Math.max(0, Math.min(1, v));
const has = (/** @type {Record<string, number>} */ v, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(v, k);
const round = (/** @type {number} */ v, /** @type {number} */ d) => Math.round(v * 10 ** d) / 10 ** d;
const on = (/** @type {any} */ v, /** @type {boolean} */ dflt) => (v === undefined || v === null ? dflt : Number(v) >= 0.5);

/**
 * Pump and fan readings that follow the valve demand and the fan speed. Only sets points that exist in `values`.
 * @param {Record<string, number>} values keyed by sourceId (demo id); mutated
 */
function step(values) {
  const mean = (/** @type {string[]} */ keys) => {
    const v = keys.filter((k) => has(values, k)).map((k) => Number(values[k]));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const pump = (/** @type {string} */ id, /** @type {number} */ demand, /** @type {number} */ floor, /** @type {number} */ qd, /** @type {number} */ pd, /** @type {number} */ sp) => {
    if (!has(values, `${id}.speed`)) return;
    const run = on(values[`${id}.run`], true);
    const s = run ? clamp01(floor + (1 - floor) * clamp01(demand / 100)) : 0;
    values[`${id}.speed`] = round(s * 100, 1);
    values[`${id}.flow`] = round(qd * s * 0.9, 2);
    values[`${id}.dp`] = run ? round(sp + (0.4 - clamp01(demand / 100)) * 10, 1) : 0;
    values[`${id}.kw`] = round(pd * s ** 3, 2);
  };
  pump('chw-pump-1', mean(['ahu-1.clg-vlv', 'ahu-2.clg-vlv']), 0.5, 16, 4.5, 80);
  pump('hw-pump-1', mean(['ahu-1.htg-vlv']), 0.6, 8, 1.5, 35);
  if (has(values, 'chw-pump-2.kw')) values['chw-pump-2.kw'] = 0;
  if (has(values, 'ahu-1.sf-speed-fb')) {
    const fanOn = on(values['ahu-1.sf-status'], true);
    const spd = fanOn ? Number(values['ahu-1.sf-speed'] ?? 70) : 0;
    values['ahu-1.sf-speed-fb'] = spd;
    values['ahu-1.flow'] = round(1200 * (spd / 100) * 0.9 * 0.93, 1);
    values['ahu-1.sf-kw'] = round(4 * (spd / 100) ** 3, 2);
  }
}

module.exports = { EXTRA_EQUIPMENT, EXTRA_POINTS, EQUIPMENT_ATTRS, step };