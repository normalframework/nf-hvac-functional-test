'use strict';

/**
 * ACME building simulator layout (public placeholder name): one packaged rooftop VAV unit (rtu-1), a hot-water boiler plant (hw-plant-1) and
 * 30 single-duct VAV boxes with hot-water reheat on two floors, 17 on floor 1 and 13 on floor 2. It mirrors the
 * structure and point roles of a real office site, with generic names. The layout lives in sim_layout_office.json.
 *
 * Points the real site has carry the same Haystack markers. Points the functional tests need that the real site does
 * not have are added and flagged `simOnly` (tagged nfftSimOnly=true), so a test is never skipped for a missing point.
 * Output is the same record shape as static/demo-nf-records.json ({ model, points }), so sim.catalog() takes it as is.
 * Units are SI. Pure: no I/O beyond reading the layout file.
 */

const LAYOUT = require('./sim_layout_office.json');

const SITE = 'office-site';
/** Starved box for the max-cooling deficiency demo: last box on floor 2, far end of the duct. */
const STARVE_ID = 'vav-2-13';

/**
 * @param {string} equip
 * @param {string} suffix
 * @param {string} dis
 * @param {string} markers without the leading point,his
 * @param {string} unit
 * @param {number|boolean} initial
 * @param {boolean} [simOnly]
 */
function pt(equip, suffix, dis, markers, unit, initial, simOnly) {
  /** @type {Record<string, any>} */
  const attrs = { id: `${equip}.${suffix}`, dis, markers: `point,his,${markers}`, equipRef: equip, siteRef: SITE, kind: typeof initial === 'boolean' ? 'Bool' : 'Number' };
  if (unit) attrs.unit = unit;
  if (simOnly) attrs.nfftSimOnly = 'true';
  return { name: attrs.id, pointType: 'POINT', attrs, latestValue: initial };
}

/** Deterministic design maximum airflow per box, 180 to 520 L/s. @param {number} i */
function boxMax(i) {
  return 180 + ((i * 73) % 35) * 10;
}

/** RTU points. The first block exists on the real site, the second is sim only. */
function rtuPoints(/** @type {string} */ id, /** @type {string} */ label) {
  return [
    pt(id, 'oat', `${label} outdoor air temperature`, 'outside,air,temp,sensor', '°C', 12),
    pt(id, 'rat', `${label} return air temperature`, 'return,air,temp,sensor', '°C', 22.5),
    pt(id, 'ra-rh', `${label} return air humidity`, 'return,air,humidity,sensor', '%', 45),
    pt(id, 'mat', `${label} mixed air temperature`, 'mixed,air,temp,sensor', '°C', 19),
    pt(id, 'dat', `${label} supply air temperature`, 'discharge,air,temp,sensor', '°C', 13.5),
    pt(id, 'dat-sp', `${label} supply air temperature setpoint`, 'discharge,air,temp,sp', '°C', 13),
    pt(id, 'dsp', `${label} duct static pressure`, 'discharge,air,pressure,sensor', 'Pa', 175),
    pt(id, 'dsp-sp', `${label} duct static pressure setpoint`, 'discharge,air,pressure,sp', 'Pa', 175),
    pt(id, 'sf-speed', `${label} supply fan speed command`, 'discharge,fan,vfd,speed,cmd,writable', '%', 65),
    pt(id, 'sf-cmd', `${label} supply fan start stop command`, 'discharge,fan,run,cmd,writable', '', true),
    pt(id, 'oa-dmp-cmd', `${label} outdoor air damper command`, 'outside,damper,cmd,writable', '%', 20),
    pt(id, 'htg-stg1-cmd', `${label} heating stage 1 command`, 'heat,cmd,writable', '', false),
    pt(id, 'clg-cap', `${label} cooling capacity status`, 'cool', '%', 0),
    pt(id, 'sf-status', `${label} supply fan status`, 'discharge,fan,run,sensor', '', true, true),
    pt(id, 'sf-speed-fb', `${label} supply fan speed feedback`, 'discharge,fan,vfd,speed,sensor', '%', 65, true),
    pt(id, 'oa-dmp', `${label} outdoor air damper position`, 'outside,damper,sensor', '%', 20, true),
    pt(id, 'ra-dmp-cmd', `${label} return air damper command`, 'return,damper,cmd,writable', '%', 80, true),
    pt(id, 'ra-dmp', `${label} return air damper position`, 'return,damper,sensor', '%', 80, true),
    pt(id, 'clg-vlv-cmd', `${label} DX cooling capacity command`, 'cool,valve,cmd,writable', '%', 50, true),
    pt(id, 'clg-vlv', `${label} DX cooling capacity feedback`, 'cool,valve,sensor', '%', 50, true),
    pt(id, 'htg-vlv-cmd', `${label} gas heat modulation command`, 'heat,valve,cmd,writable', '%', 0, true),
    pt(id, 'htg-vlv', `${label} gas heat modulation feedback`, 'heat,valve,sensor', '%', 0, true),
  ];
}

function plantPoints(/** @type {string} */ id, /** @type {string} */ label) {
  return [
    pt(id, 'hws-t', `${label} hot water supply temperature`, 'hot,water,leaving,temp,sensor', '°C', 60),
    pt(id, 'hwr-t', `${label} hot water return temperature`, 'hot,water,entering,temp,sensor', '°C', 50),
    pt(id, 'dp', `${label} hot water differential pressure`, 'hot,water,delta,pressure,sensor', 'kPa', 40),
    pt(id, 'pump-speed', `${label} system pump VFD signal`, 'hot,water,pump,vfd,speed,cmd,writable', '%', 55),
    pt(id, 'blr-fire', `${label} boiler firing rate`, 'hot,water,boiler', '%', 20),
  ];
}

/**
 * How a functional test can command this box to its cooling maximum. Vendor-a boxes take an airflow setpoint write
 * (a sim addition: the real site's setpoint is read-only). Vendor-b boxes keep the real read-only setpoint; the sim
 * gives five a purge point (the toggle_boolean / flush_point strategy) and leaves three with no override at all
 * (unsupported), so the per-box strategy fallback shows up in one run.
 * @param {any} zone
 * @returns {'flow_sp' | 'purge' | 'none'}
 */
function overrideOf(zone) {
  if (zone.controller_family !== 'vendor-b') return 'flow_sp';
  const order = (LAYOUT.zones || []).filter((z) => z.controller_family === 'vendor-b').map((z) => z.id);
  const k = order.indexOf(zone.id);
  if (k < 5) return 'purge';
  return 'none';
}

/**
 * @param {any} zone layout zone
 * @param {number} i 0-based index across the building
 */
function vavPoints(zone, i) {
  const id = zone.vav;
  const label = id.toUpperCase();
  const max = boxMax(i);
  const override = overrideOf(zone);
  // Two controller families on the real site tag the reheat output differently; the sim keeps both.
  const reheat = zone.controller_family === 'vendor-b'
    ? pt(id, 'rh-cmd', `${label} heating valve command`, 'discharge,hot,water,heat,reheat,valve,cmd,writable', '%', 0)
    : pt(id, 'rh-cmd', `${label} heating output command`, 'heat,cmd,writable', '%', 0);
  return [
    pt(id, 'zat', `${label} zone air temperature`, 'zone,air,temp,sensor', '°C', 22 + ((i % 5) - 2) * 0.3),
    pt(id, 'zat-sp', `${label} zone air temperature setpoint`, 'zone,air,temp,sp', '°C', 22),
    pt(id, 'flow', `${label} discharge airflow`, 'discharge,air,flow,sensor', 'L/s', Math.round(max * 0.45)),
    // Vendor-b boxes mirror the real site: the airflow setpoint is read-only, so the test needs a fallback strategy.
    pt(id, 'flow-sp', `${label} airflow setpoint`, override === 'flow_sp' ? 'discharge,air,flow,sp,writable' : 'discharge,air,flow,sp', 'L/s', Math.round(max * 0.45)),
    pt(id, 'dat', `${label} discharge air temperature`, 'discharge,air,temp,sensor', '°C', 14),
    pt(id, 'dmp-cmd', `${label} damper command`, 'discharge,damper,cmd,writable', '%', 45),
    reheat,
    pt(id, 'flow-max', `${label} maximum airflow setpoint`, 'discharge,max,air,flow,sp', 'L/s', max, true),
    pt(id, 'dmp', `${label} damper position`, 'discharge,damper,sensor', '%', 45, true),
    ...(override === 'purge' ? [pt(id, 'purge-cmd', `${label} purge command`, 'purge,cmd,writable', '', 0, true)] : []),
  ];
}

/**
 * Records for the office layout, in demo-nf-records shape.
 * @param {any} [layout] defaults to sim_layout_office.json
 */
function records(layout) {
  const L = layout || LAYOUT;
  /** @type {any[]} */
  const model = [{ name: L.building.name, pointType: 'SITE', attrs: { id: SITE, dis: L.building.name, markers: 'site', floors: String(L.building.floors) } }];
  /** @type {any[]} */
  const points = [];
  for (const ahu of L.ahus) {
    model.push({ name: ahu.id.toUpperCase(), pointType: 'EQUIPMENT', attrs: { id: ahu.id, dis: ahu.id.toUpperCase(), markers: 'equip,ahu,rooftop,vav', siteRef: SITE } });
    points.push(...rtuPoints(ahu.id, ahu.id.toUpperCase()));
  }
  for (const plant of L.hw_plants) {
    const label = 'HW plant 1';
    model.push({ name: label, pointType: 'EQUIPMENT', attrs: { id: plant.id, dis: label, markers: 'equip,hot,water,plant,boiler,pump', siteRef: SITE } });
    points.push(...plantPoints(plant.id, label));
  }
  L.zones.forEach((/** @type {any} */ z, /** @type {number} */ i) => {
    const label = `${z.vav.toUpperCase()} (floor ${z.floor})`;
    /** @type {Record<string, string>} */
    const attrs = { id: z.vav, dis: label, markers: 'equip,vav,airTerminalUnit,hotWaterReheat', siteRef: SITE, airRef: z.fed_by_ahu, floor: String(z.floor) };
    model.push({ name: label, pointType: 'EQUIPMENT', attrs });
    points.push(...vavPoints(z, i));
  });
  return { note: 'ACME building simulator layout (generic names).', model, points, scenarios: [] };
}

/** VAV id -> the AHU that feeds it. @param {any} [layout] */
function feeds(layout) {
  const L = layout || LAYOUT;
  return Object.fromEntries(L.zones.map((/** @type {any} */ z) => [z.vav, z.fed_by_ahu]));
}

module.exports = { LAYOUT, SITE, STARVE_ID, records, feeds, boxMax, overrideOf };
