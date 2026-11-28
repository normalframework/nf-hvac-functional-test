'use strict';

/**
 * Optional bench-station simulator. Pure helpers plus a run() that talks to NF's
 * local BACnet API. Off unless the app option enableSimulator is true and
 * simulatorConfirm is exactly CREATE_LOCAL_SIM. Creates only new local objects
 * (POST /api/v1/bacnet/local never includes a uuid), never overwrites an
 * instance whose name this hook did not choose, and never writes to real devices. Present-value and tag updates are
 * small rotating batches; this hook does not keep an in-memory history.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const opoint = require('./sim_opoint.js');
const office = require('./sim_office.js');
const openfddRoles = require('./openfdd_roles.js');
const simSiteConfig = require('./sim_site_config.js');

const CONFIRM_PHRASE = 'CREATE_LOCAL_SIM';
const NAME_PREFIX = 'nfft-sim.';
const ID_PREFIX = 'nfft-sim-';
const SITE_ID = 'nfft-sim-site';
const INSTANCE_BASE = 8000;
const CREATE_BATCH = 8;
const PATCH_BATCH = 15;
const TAG_POINT_BATCH = 8;
// While the model layer is still missing point records (first ticks after install) tag more per tick so a fresh
// bench is complete in a few minutes instead of 15 to 30. Back to TAG_POINT_BATCH once every record exists.
const TAG_POINT_BATCH_CATCHUP = 40;
// The office layout has about 300 objects: create and patch in bigger batches so a bench is built in a few ticks and
// a functional test's overrides show up in the sensors within one tick.
const OFFICE_CREATE_BATCH = 30;
const OFFICE_PATCH_BATCH = 60;
const STARVE_ID = 'vav-03';
const STARVE_FACTOR = 0.45;
const DESIGN_PA = 250;
// Stable namespace so model-only SITE/EQUIPMENT records get the same uuid every tick.
const TAG_NAMESPACE = 'a7c4e6f0-1b25-5d9a-9c33-6e6666747369';

/**
 * @param {any} value
 * @returns {boolean}
 */
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
}

/**
 * RFC 4122 UUID v5 of `name` in TAG_NAMESPACE. NF 3.10 requires a uuid on
 * POST /api/v1/point/points even for new model records.
 * @param {string} name
 * @returns {string}
 */
function stableUuid(name) {
  const ns = Buffer.from(TAG_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(String(name), 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}


/** @type {any} */
let cachedRecords = null;

/**
 * @param {string} [file]
 */
function demoRecords(file) {
  if (cachedRecords && !file) return cachedRecords;
  const dest = file || path.join(__dirname, '../../static/demo-nf-records.json');
  const rec = JSON.parse(fs.readFileSync(dest, 'utf8'));
  if (!file) cachedRecords = rec;
  return rec;
}

/**
 * NF may pass an option as a bare scalar or as {boolean|string|number}.
 * @param {any} value
 */
function unwrapOption(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.prototype.hasOwnProperty.call(value, 'boolean')) return value.boolean;
    if (Object.prototype.hasOwnProperty.call(value, 'string')) return value.string;
    if (Object.prototype.hasOwnProperty.call(value, 'number')) return value.number;
  }
  return value;
}

/**
 * @param {any} options hook / app options
 */
function isArmed(options) {
  const o = options || {};
  const rawFlag = unwrapOption(o.enableSimulator);
  const flag = rawFlag === true || rawFlag === 'true' || rawFlag === 1;
  const phrase = String(unwrapOption(o.simulatorConfirm) || '').trim();
  return flag && phrase === CONFIRM_PHRASE;
}

/**
 * BACnet EngineeringUnits enumerations (ASHRAE 135). NF 3.10.9 rejects
 * CreateLocalObject for analog values unless PROP_UNITS is present.
 * @param {string} [unit]
 * @returns {number}
 */
function bacnetUnits(unit) {
  switch (String(unit || '').trim()) {
    case '%':
    case 'PERCENT':
    case 'percent':
      return 98;
    case '°C':
    case 'degC':
    case 'DEG_C':
      return 62;
    case 'Pa':
    case 'PA':
    case 'pascals':
      return 53;
    case 'L/s':
    case 'L-PER-SEC':
    case 'L/S':
      return 87;
    case 'kPa':
    case 'KiloPA':
      return 54;
    case 'kW':
    case 'KiloW':
      return 48;
    default:
      return 95;
  }
}

/**
 * @param {any} err
 * @returns {string}
 */
function httpErrorMessage(err) {
  const e = err || {};
  const headers = (e.response && e.response.headers) || e.headers || {};
  const grpc = headers['grpc-message'] || headers['Grpc-Message'] || '';
  const data = e.response && e.response.data;
  let detail = '';
  if (typeof data === 'string') detail = data;
  else if (data && (data.message || data.error)) detail = String(data.message || data.error);
  const base = e.message ? String(e.message) : String(e);
  return [base, grpc, detail].filter(Boolean).filter((s, i, a) => a.indexOf(s) === i).join(': ');
}

/**
 * Rewrite a demo id so bench objects never collide with a real site's ids.
 * @param {string} id
 */
function simId(id) {
  const raw = String(id || '');
  if (!raw) return raw;
  if (raw === 'demo-site') return SITE_ID;
  return raw.startsWith(ID_PREFIX) ? raw : ID_PREFIX + raw;
}

/**
 * @param {any} rec demo-nf-records; when given (tests), only that fixture is used and no operating point extras are added
 */
function catalog(rec, opts) {
  const layout = (opts && opts.layout) || 'demo';
  const records = rec || (layout === 'office' ? office.records() : demoRecords());
  // Operating point extras belong to the demo layout (chw pumps, AHU-1 fan); the office layout carries its own points.
  const withExtras = !rec && layout !== 'office';
  const equipment = (records.model || [])
    .filter((/** @type {any} */ r) => r.pointType !== 'SITE' && (r.attrs || {}).markers)
    .map((/** @type {any} */ r) => {
      const attrs = r.attrs || {};
      const out = {
        id: simId(attrs.id),
        dis: attrs.dis || attrs.id,
        markers: attrs.markers,
        siteRef: SITE_ID,
        kind: /ahu/.test(attrs.markers) ? 'ahu'
          : /vav|airTerminal/.test(attrs.markers) ? 'vav'
          : /boiler/.test(attrs.markers) ? 'boiler'
          : /pump/.test(attrs.markers) ? 'pump'
          : 'equip',
      };
      if (attrs.airRef) out.airRef = simId(attrs.airRef);
      if (attrs.feeds) out.feeds = simId(attrs.feeds);
      if (attrs.isFedBy) out.isFedBy = simId(attrs.isFedBy);
      if (attrs.floor) out.floor = String(attrs.floor);
      if (withExtras && /** @type {any} */ (opoint.EQUIPMENT_ATTRS)[attrs.id]) out.extra = /** @type {any} */ (opoint.EQUIPMENT_ATTRS)[attrs.id];
      return out;
    });
  if (withExtras) {
    for (const e of opoint.EXTRA_EQUIPMENT) {
      const extra = /** @type {any} */ (opoint.EQUIPMENT_ATTRS)[e.id];
      equipment.push({ id: simId(e.id), dis: e.dis, markers: e.markers, siteRef: SITE_ID, kind: e.kind, ...(extra ? { extra } : {}) });
    }
  }
  const siteRow = (records.model || []).find((/** @type {any} */ r) => r.pointType === 'SITE');
  const site = { id: SITE_ID, dis: layout === 'office' && siteRow ? siteRow.attrs.dis : 'Functional test bench site', markers: 'site' };
  const points = (records.points || []).map((/** @type {any} */ r) => {
    const attrs = r.attrs || {};
    const kind = attrs.kind || (typeof r.latestValue === 'boolean' ? 'Bool' : 'Number');
    return {
      name: NAME_PREFIX + (attrs.id || r.name),
      sourceId: attrs.id || r.name,
      dis: attrs.dis || attrs.id || r.name,
      markers: attrs.markers || 'point,his',
      kind,
      unit: attrs.unit || '',
      equipRef: simId(attrs.equipRef),
      siteRef: SITE_ID,
      objectType: kind === 'Bool' ? 'OBJECT_BINARY_VALUE' : 'OBJECT_ANALOG_VALUE',
      initial: r.latestValue === undefined || r.latestValue === null ? 0 : r.latestValue,
      simOnly: attrs.nfftSimOnly === 'true',
    };
  });
  if (withExtras) {
    for (const p of opoint.EXTRA_POINTS) {
      points.push({
        name: NAME_PREFIX + p.sourceId, sourceId: p.sourceId, dis: p.dis, markers: p.markers, kind: p.kind, unit: p.unit,
        equipRef: simId(p.equip), siteRef: SITE_ID, objectType: p.kind === 'Bool' ? 'OBJECT_BINARY_VALUE' : 'OBJECT_ANALOG_VALUE', initial: p.initial,
      });
    }
  }
  /** @type {Record<string, string>} */
  const feedsMap = {};
  for (const r of records.model || []) {
    const a = r.attrs || {};
    if (a.airRef && a.id) feedsMap[a.id] = a.airRef;
  }
  if (layout === 'office') {
    // Open-FDD role id per point, matched from the same Haystack tags Open-FDD binds on. Left off where only a
    // catch-all role or a role of another quantity matches (see openfdd_roles.conformance for the gap list).
    const eqMarkers = new Map(equipment.map((/** @type {any} */ e) => [e.id, e.markers]));
    for (const p of points) {
      const m = openfddRoles.matchRole(p.markers, eqMarkers.get(p.equipRef) || '');
      if (m.role && !(m.gap && m.gap.startsWith('binds as'))) p.roleRef = m.role;
    }
  }
  return { site, equipment, points, layout, feeds: feedsMap, starve: layout === 'office' ? office.STARVE_ID : STARVE_ID };
}

/**
 * @param {any} listing GET /api/v1/bacnet/local body
 */
function indexLocal(listing) {
  /** @type {Map<number, { name: string, objectType: string, instance: number, uuid?: string }>} */
  const byInstance = new Map();
  /** @type {Map<string, { name: string, objectType: string, instance: number, uuid?: string }>} */
  const byName = new Map();
  for (const o of (listing && listing.objects) || []) {
    const id = o.objectId || {};
    const instance = Number(id.instance);
    if (!Number.isFinite(instance)) continue;
    const name = ((((o.props || []).find((/** @type {any} */ x) => x.property === 'PROP_OBJECT_NAME') || {}).value) || {}).characterString
      || o.name || '';
    const rec = { name, objectType: id.objectType || 'OBJECT_ANALOG_VALUE', instance };
    if (typeof o.uuid === 'string' && o.uuid && name.startsWith(NAME_PREFIX)) rec.uuid = o.uuid;
    byInstance.set(instance, rec);
    if (name) byName.set(name, rec);
  }
  return { byInstance, byName };
}

/**
 * Decide creates, patches and skips. Never reuses a foreign instance. Never emits a uuid.
 * @param {any} listing
 * @param {any} cat catalog()
 * @param {{ instanceBase?: number }} [opts]
 */
function planSync(listing, cat, opts) {
  const index = indexLocal(listing);
  let next = (opts && opts.instanceBase) || INSTANCE_BASE;
  const taken = new Set(index.byInstance.keys());
  const free = () => {
    while (taken.has(next)) next += 1;
    const n = next;
    taken.add(n);
    next += 1;
    return n;
  };
  /** @type {any[]} */
  const create = [];
  /** @type {any[]} */
  const patch = [];
  /** @type {any[]} */
  const skip = [];
  for (const pt of cat.points) {
    const have = index.byName.get(pt.name);
    if (have) {
      if (have.name === pt.name) patch.push({ ...pt, instance: have.instance, objectType: have.objectType || pt.objectType });
      else skip.push({ ...pt, instance: have.instance, reason: 'name_mismatch' });
      continue;
    }
    const instance = free();
    const collision = index.byInstance.get(instance);
    if (collision && collision.name && collision.name !== pt.name) {
      skip.push({ ...pt, instance, reason: 'instance_collision' });
      continue;
    }
    create.push({ ...pt, instance });
  }
  return { create, patch, skip };
}

/**
 * POST /api/v1/bacnet/local body. No uuid field.
 * @param {any} item planSync create entry
 * @param {number | boolean} value
 */

/**
 * Rotate through a list across 60-second ticks so a small box is not hit with every object at once.
 * @param {any[]} arr
 * @param {number} limit
 * @param {number} now
 */
function sliceRotate(arr, limit, now) {
  if (!arr.length || arr.length <= limit) return arr;
  const start = (Math.floor(Number(now) / 60000) * limit) % arr.length;
  /** @type {any[]} */
  const out = [];
  for (let i = 0; i < limit; i += 1) out.push(arr[(start + i) % arr.length]);
  return out;
}

/**
 * Uuid NF assigned when this hook created a local object. Never returned for a foreign name.
 * @param {any} listing
 * @param {string} name
 * @returns {string|undefined}
 */
function ownedUuid(listing, name) {
  if (!name || !String(name).startsWith(NAME_PREFIX)) return undefined;
  const rec = indexLocal(listing).byName.get(name);
  if (!rec || !String(rec.name || '').startsWith(NAME_PREFIX) || !isUuid(rec.uuid)) return undefined;
  return rec.uuid;
}

function createBody(item, value) {
  const objectId = { objectType: item.objectType, instance: item.instance };
  /** @type {{ property: string, value: { characterString?: string, enumerated?: number, real?: number } }[]} */
  const props = [
    { property: 'PROP_OBJECT_NAME', value: { characterString: item.name } },
    { property: 'PROP_DESCRIPTION', value: { characterString: item.dis } },
  ];
  // Analog values require Units on NF 3.10.9 CreateLocalObject.
  if (item.objectType !== 'OBJECT_BINARY_VALUE') {
    props.push({ property: 'PROP_UNITS', value: { enumerated: bacnetUnits(item && item.unit) } });
  }
  props.push(presentValueProp(item, value));
  return { objectId, props };
}

/**
 * @param {any} item
 * @param {any} value
 */
function presentValueProp(item, value) {
  if (item.objectType === 'OBJECT_BINARY_VALUE') {
    const on = value === true || value === 1 || value === 'active' || value === 'true';
    return { property: 'PROP_PRESENT_VALUE', value: { enumerated: on ? 1 : 0 } };
  }
  const n = Number(value);
  return { property: 'PROP_PRESENT_VALUE', value: { real: Number.isFinite(n) ? Math.round(n * 100) / 100 : 0 } };
}

/**
 * @param {any} item
 * @param {number | boolean} value
 */
function patchBody(item, value) {
  return {
    objectId: { objectType: item.objectType, instance: item.instance },
    props: [presentValueProp(item, value)],
  };
}

/**
 * @param {any} v
 * @param {boolean} fallback
 */
function onOff(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (v === true || v === 'true' || v === 'active') return true;
  if (v === false || v === 'false' || v === 'inactive') return false;
  return Number(v) >= 0.5;
}

/**
 * @param {Record<string, number>} values keyed by sourceId (demo id)
 * @param {string} ahu
 */
function applyAhu(values, ahu) {
  const fanOn = onOff(values[`${ahu}.sf-status`], onOff(values[`${ahu}.sf-cmd`], true));
  const fanSpd = fanOn ? Number(values[`${ahu}.sf-speed`] ?? 70) : 0;
  values[`${ahu}.sf-status`] = fanOn ? 1 : 0;
  values[`${ahu}.sf-speed`] = fanSpd;
  const staticPa = fanOn ? DESIGN_PA * Math.max(0.2, (fanSpd / 100) ** 2) : 0;
  values[`${ahu}.dsp`] = Math.round(staticPa * 10) / 10;
  return { fanOn, staticPa };
}

/**
 * Simple airflow physics for the bench points. VAV-03 is capacity-starved so a
 * max-cooling run can show a deficiency without touching any real equipment.
 * @param {Record<string, number>} values keyed by sourceId (demo id)
 */
function stepPhysics(values, opts) {
  if (opts && opts.layout === 'office') return stepOffice(values, opts);
  const next = { ...values };
  applyAhu(next, 'ahu-1');
  if (Object.prototype.hasOwnProperty.call(next, 'ahu-2.sf-speed')
    || Object.prototype.hasOwnProperty.call(next, 'ahu-2.sf-status')) {
    applyAhu(next, 'ahu-2');
  }
  function boxFlow(prefix, starve, fanOn, staticPa) {
    const max = next[`${prefix}.flow-max`] ?? 300;
    const cmd = next[`${prefix}.dmp-cmd`] ?? next[`${prefix}.dmp`] ?? 40;
    const blade = next[`${prefix}.dmp`] ?? cmd;
    const cap = Math.max(0.02, (Number(blade) / 100) ** 1.5);
    let q = max * cap * Math.sqrt(Math.max(staticPa, 0) / DESIGN_PA);
    if (starve) q *= STARVE_FACTOR;
    if (!fanOn) q = 0;
    next[`${prefix}.flow`] = Math.round(q * 10) / 10;
    if (next[`${prefix}.dmp`] === undefined) next[`${prefix}.dmp`] = cmd;
  }
  const boxes = Array.from(new Set(Object.keys(next).map((k) => (k.match(/^(vav-[0-9]+)\./) || [])[1]).filter(Boolean)));
  for (const id of boxes) {
    const use = /^vav-2/.test(id) ? 'ahu-2' : 'ahu-1';
    const fanOn = onOff(next[`${use}.sf-status`], true);
    const staticPa = Number(next[`${use}.dsp`] ?? (fanOn ? DESIGN_PA : 0));
    boxFlow(id, id === STARVE_ID, fanOn, staticPa);
  }
  opoint.step(next);
  return next;
}

/**
 * Illustrative teaching fan for the office rooftop unit, sized to the 30 boxes' summed maximum (10.05 m3/s):
 * fan total pressure = speed^2 * p0 - a * Q^2 (Pa, m3/s), so 750 Pa at 10 m3/s and full speed; duct static at the
 * sensor = fan pressure - b * Q^2. Replaced by EnergyPlus design values when a design file is loaded in the page.
 */
const OFFICE_FAN = Object.freeze({ p0: 1000, a: 2.5, b: 3.5, eta: 0.65, minSpeed: 0.25, designFlowM3s: 10.0, designPressurePa: 750 });

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(hi, v));
const r1 = (/** @type {number} */ v) => Math.round(v * 10) / 10;
const num = (/** @type {any} */ v, /** @type {number} */ d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '' ? Number(v) : d);

/**
 * Office layout physics. Commands and setpoints (whatever NF holds, including a functional test's override) drive the
 * sensors: fan command and speed set static pressure and fan status; damper commands set the outdoor air fraction and
 * the mixed air temperature; DX and gas commands move the supply air temperature; each box follows its airflow
 * setpoint up to what the duct static can deliver (one box is starved); damper position and zone temperature follow.
 * @param {Record<string, number>} values keyed by sourceId; not mutated
 * @param {{ feeds?: Record<string, string>, starve?: string, fan?: any }} opts
 */
function stepOffice(values, opts) {
  const next = { ...values };
  const feedsMap = (opts && opts.feeds) || {};
  const ahus = Array.from(new Set(Object.keys(next).map((k) => (k.match(/^((?:rtu|ahu)-[0-9]+)\.sf-speed$/) || [])[1]).filter(Boolean)));
  const boxes = Array.from(new Set(Object.keys(next).map((k) => (k.match(/^(vav-[0-9][0-9-]*)\.flow-sp$/) || [])[1]).filter(Boolean)));
  const fan = { ...OFFICE_FAN, ...((opts && opts.fan) || {}) };
  /** Airflow a box asks for (L/s): its maximum while a max-cooling or purge override is on, else its setpoint. */
  const demand = (/** @type {string} */ b) => {
    const max = num(next[`${b}.flow-max`], 300);
    if (onOff(next[`${b}.max-cool-cmd`], false) || onOff(next[`${b}.purge-cmd`], false)) return max;
    return clamp(num(next[`${b}.flow-sp`], max * 0.45), 0, max * 1.2);
  };
  /** Airflow each box gets (L/s) at a duct static (Pa). */
  const delivered = (/** @type {string[]} */ list, /** @type {number} */ staticPa) => Object.fromEntries(list.map((b) => {
    const max = num(next[`${b}.flow-max`], 300);
    let capacity = 1.1 * max * Math.sqrt(Math.max(staticPa, 0) / 175);
    if (b === (opts && opts.starve)) capacity *= STARVE_FACTOR;
    return [b, Math.min(demand(b), capacity)];
  }));
  /** @type {Record<string, { fanOn: boolean, staticPa: number, dat: number, flows: Record<string, number> }>} */
  const air = {};
  for (const a of ahus) {
    const served = boxes.filter((b) => (feedsMap[b] || ahus[0]) === a);
    const fanOn = onOff(next[`${a}.sf-cmd`], true);
    const sp = num(next[`${a}.dsp-sp`], 175);
    // Built-in duct static loop (the sim plays the BAS): speed moves toward what holds the setpoint at today's demand.
    const qDemand = served.reduce((t, b) => t + demand(b), 0) / 1000;
    const k = fan.a + fan.b;
    const s0 = clamp(num(next[`${a}.sf-speed-fb`], 65) / 100, 0, 1);
    /** Duct static and box flows at a fan speed. @param {number} speed */
    const solve = (speed) => {
      let q = qDemand;
      let st = 0;
      /** @type {Record<string, number>} */
      let f = {};
      for (let i = 0; i < 12; i += 1) {
        st = Math.max(0, speed * speed * fan.p0 - k * q * q);
        f = delivered(served, st);
        q = 0.5 * q + 0.5 * Object.values(f).reduce((t, v) => t + v, 0) / 1000;
      }
      return { st, f, q };
    };
    // Speed that holds the setpoint at the flow the boxes actually take, then a one-minute slew toward it.
    let sReq = clamp(Math.sqrt((sp + k * qDemand * qDemand) / fan.p0), fan.minSpeed, 1);
    for (let i = 0; i < 3; i += 1) sReq = clamp(Math.sqrt((sp + k * solve(sReq).q ** 2) / fan.p0), fan.minSpeed, 1);
    const sNow = fanOn ? clamp(s0 + 0.6 * (sReq - s0), fan.minSpeed, 1) : 0;
    let staticPa = 0;
    /** @type {Record<string, number>} */
    let flows = Object.fromEntries(served.map((b) => [b, 0]));
    if (fanOn) {
      const solved = solve(sNow);
      staticPa = solved.st;
      flows = solved.f;
    }
    const qAir = Object.values(flows).reduce((t, v) => t + v, 0) / 1000;
    const fanDp = fanOn ? Math.max(0, sNow * sNow * fan.p0 - fan.a * qAir * qAir) : 0;
    next[`${a}.sf-status`] = fanOn ? 1 : 0;
    if (`${a}.sf-speed-fb` in next) next[`${a}.sf-speed-fb`] = r1(sNow * 100);
    next[`${a}.dsp`] = r1(staticPa);
    const oaCmd = clamp(num(next[`${a}.oa-dmp-cmd`], 20), 0, 100);
    const raCmd = clamp(num(next[`${a}.ra-dmp-cmd`], 100 - oaCmd), 0, 100);
    if (`${a}.oa-dmp` in next) next[`${a}.oa-dmp`] = r1(oaCmd);
    if (`${a}.ra-dmp` in next) next[`${a}.ra-dmp`] = r1(raCmd);
    const oat = num(next[`${a}.oat`], 12);
    const rat = num(next[`${a}.rat`], 22.5);
    const oaFrac = oaCmd + raCmd > 0 ? oaCmd / (oaCmd + raCmd) : 0;
    // A small fixed sensor offset, inside a 0.5 K class sensor's tolerance, so MAT never reads exactly RAT.
    const mat = (fanOn ? oaFrac * oat + (1 - oaFrac) * rat : rat) + 0.2;
    next[`${a}.mat`] = r1(mat);
    const clg = clamp(num(next[`${a}.clg-vlv-cmd`], 0), 0, 100);
    const htgMod = clamp(num(next[`${a}.htg-vlv-cmd`], 0), 0, 100);
    const stage1 = onOff(next[`${a}.htg-stg1-cmd`], false) ? 30 : 0;
    const htg = Math.max(htgMod, stage1);
    if (`${a}.clg-vlv` in next) next[`${a}.clg-vlv`] = r1(clg);
    if (`${a}.htg-vlv` in next) next[`${a}.htg-vlv`] = r1(htgMod);
    next[`${a}.clg-cap`] = r1(clg);
    // Fan heat: the fan's total pressure rise ends up in the air stream (motor in the air stream), dT = dP / (eta rho cp).
    const fanHeat = fanOn ? fanDp / (fan.eta * 1.2 * 1006) : 0;
    const dat = fanOn ? mat + fanHeat - 0.14 * clg + 0.25 * htg : mat;
    next[`${a}.dat`] = r1(dat);
    air[a] = { fanOn, staticPa, dat, flows };
  }
  let reheatSum = 0;
  for (const b of boxes) {
    const src = air[feedsMap[b] || ahus[0]] || { fanOn: false, staticPa: 0, dat: 14, flows: {} };
    const max = num(next[`${b}.flow-max`], 300);
    let capacity = 1.1 * max * Math.sqrt(Math.max(src.staticPa, 0) / 175);
    if (b === (opts && opts.starve)) capacity *= STARVE_FACTOR;
    const q = src.fanOn ? (src.flows[b] ?? 0) : 0;
    next[`${b}.flow`] = r1(q);
    const blade = capacity > 0 ? clamp(100 * Math.sqrt(Math.min(1, demand(b) / capacity)), 5, 100) : 100;
    if (`${b}.dmp` in next) next[`${b}.dmp`] = r1(blade);
    const rh = clamp(num(next[`${b}.rh-cmd`], 0), 0, 100);
    reheatSum += rh;
    const dat = src.dat + 0.2 * rh;
    next[`${b}.dat`] = r1(dat);
    const zsp = num(next[`${b}.zat-sp`], 22);
    const zat = num(next[`${b}.zat`], zsp);
    // Load pushes the zone up, supply air pulls it toward the discharge temperature; settles within a few ticks.
    const pull = max > 0 ? (q / max) * 0.25 : 0;
    const drift = 0.08 + pull * (dat - zat) / 4;
    next[`${b}.zat`] = r1(clamp(zat + drift + (zsp - zat) * 0.05, 12, 32));
  }
  const plants = Array.from(new Set(Object.keys(next).map((k) => (k.match(/^(hw-plant-[0-9]+)\.pump-speed$/) || [])[1]).filter(Boolean)));
  for (const p of plants) {
    const demand = boxes.length ? reheatSum / boxes.length : 0;
    const spd = clamp(num(next[`${p}.pump-speed`], 55), 0, 100);
    next[`${p}.dp`] = r1(70 * (spd / 100) ** 2);
    next[`${p}.blr-fire`] = r1(clamp(15 + demand * 0.9, 0, 100));
    next[`${p}.hws-t`] = r1(60);
    next[`${p}.hwr-t`] = r1(60 - 4 - demand * 0.08);
  }
  return next;
}

/**
 * Starting values from the catalog initials, then one physics step.
 * @param {any} cat
 */
function initialValues(cat) {
  /** @type {Record<string, number>} */
  const values = {};
  for (const p of cat.points) {
    const n = typeof p.initial === 'boolean' ? (p.initial ? 1 : 0) : Number(p.initial);
    values[p.sourceId] = Number.isFinite(n) ? n : 0;
  }
  return stepPhysics(values, cat);
}

/**
 * Present values NF holds now for objects this hook owns, keyed by sourceId. A functional test's command shows up here.
 * @param {any} listing GET /api/v1/bacnet/local
 * @param {any} cat
 */
function currentValues(listing, cat) {
  /** @type {Map<string, string>} */
  const byName = new Map(cat.points.map((/** @type {any} */ p) => [p.name, p.sourceId]));
  /** @type {Record<string, number>} */
  const out = {};
  for (const o of (listing && listing.objects) || []) {
    const props = o.props || [];
    const name = (((props.find((/** @type {any} */ x) => x.property === 'PROP_OBJECT_NAME') || {}).value) || {}).characterString || '';
    const id = byName.get(name);
    if (!id) continue;
    const v = ((props.find((/** @type {any} */ x) => x.property === 'PROP_PRESENT_VALUE') || {}).value) || {};
    const n = v.real !== undefined ? Number(v.real) : v.enumerated !== undefined ? Number(v.enumerated) : v.unsigned !== undefined ? Number(v.unsigned) : NaN;
    if (Number.isFinite(n)) out[id] = n;
  }
  return out;
}

/**
 * @param {{ url: string, method?: string, body?: any }} req
 */
function assertNoUuid(req) {
  const url = String((req && req.url) || req || '');
  if (!/\/api\/v1\/bacnet\/local/.test(url)) return;
  const body = req && /** @type {any} */ (req).body;
  if (body && Object.prototype.hasOwnProperty.call(body, 'uuid')) {
    throw new Error('refusing to POST /api/v1/bacnet/local with a uuid');
  }
}

/**
 * @param {any} data axios-like or raw
 */
function unwrap(data) {
  if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'data') && data.data !== undefined && data.status !== undefined) {
    return data.data;
  }
  return data;
}

/**
 * One simulator tick. No BACnet calls when the simulator is not armed.
 * @param {any} sdk
 * @param {{ options?: any, http?: any, log?: Function, now?: number, records?: any, createLimit?: number, patchLimit?: number, tagLimit?: number, skipTags?: boolean, stateRoot?: string }} [ctx]
 */
async function run(sdk, ctx) {
  const options = (ctx && ctx.options) || (sdk && sdk.options) || {};
  const http = (ctx && ctx.http) || (sdk && sdk.http);
  const log = (ctx && ctx.log) || (sdk && sdk.log) || (() => {});
  if (!isArmed(options)) {
    return { ok: true, skipped: 'disabled', created: 0, patched: 0, skipped_objects: 0 };
  }
  if (!http || typeof http.get !== 'function') {
    return { ok: false, code: 'no_http' };
  }
  try {
    await http.get('/api/v1/bacnet/configuration');
  } catch (err) {
    const e = /** @type {any} */ (err);
    log(`simulator: NF BACnet server not present (${e && e.message ? e.message : e})`);
    return { ok: true, skipped: 'no_bacnet_server', created: 0, patched: 0 };
  }
  const listing = unwrap(await http.get('/api/v1/bacnet/local'));
  const layout = ctx && ctx.records ? 'demo' : (String(unwrapOption(options.simulatorLayout) || 'office').trim() === 'demo' ? 'demo' : 'office');
  const cat = catalog(ctx && ctx.records, { layout });
  if (layout === 'office') {
    // Fault injection is opt-in on the office layout, so a clean sim run can pass and be signed off.
    const faults = String(unwrapOption(options.simulatorFaults) || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!faults.includes('starved_box')) /** @type {any} */ (cat).starve = undefined;
  }
  const planned = planSync(listing, cat);
  // Office layout: start from what NF holds now, so commands (including a test's overrides) drive the sensors.
  const held = layout === 'office' ? currentValues(listing, cat) : {};
  const values = layout === 'office' ? stepPhysics({ ...initialValues(cat), ...held }, cat) : initialValues(cat);
  const now = (ctx && ctx.now) || Date.now();
  const limit = (ctx && ctx.createLimit) || (layout === 'office' ? OFFICE_CREATE_BATCH : CREATE_BATCH);
  const toCreate = planned.create.slice(0, limit);
  let created = 0;
  for (const item of toCreate) {
    const body = createBody(item, values[item.sourceId]);
    assertNoUuid({ url: '/api/v1/bacnet/local', body });
    try {
      await http.post('/api/v1/bacnet/local', body);
    } catch (err) {
      throw new Error(`CreateLocalObject ${item.objectType} ${item.instance} ${item.name}: ${httpErrorMessage(err)}`);
    }
    created += 1;
    log(`simulator: created ${item.objectType} ${item.instance} ${item.name}`);
  }
  let patched = 0;
  // Only patch objects we already own (by name). Defer patching and tagging while creates are in
  // flight so a tick stays inside the hook timeout on a small box.
  const patchLimit = (ctx && ctx.patchLimit) || (layout === 'office' ? OFFICE_PATCH_BATCH : PATCH_BATCH);
  /** @type {any[]} */
  let patchable = planned.patch;
  if (layout === 'office') {
    // Never patch a writable point: NF and the functional test own it. Patch sensors whose value moved, biggest first.
    patchable = planned.patch
      .filter((/** @type {any} */ p) => !/(^|,)writable(,|$)/.test(p.markers))
      .filter((/** @type {any} */ p) => !(p.sourceId in held) || Math.abs(Number(values[p.sourceId]) - held[p.sourceId]) >= 0.05)
      .sort((/** @type {any} */ a, /** @type {any} */ b) => Math.abs(Number(values[b.sourceId]) - (held[b.sourceId] ?? 0)) - Math.abs(Number(values[a.sourceId]) - (held[a.sourceId] ?? 0)));
  }
  const toPatch = toCreate.length === 0 ? (layout === 'office' ? patchable.slice(0, patchLimit) : sliceRotate(patchable, patchLimit, now)) : [];
  for (const item of toPatch) {
    const body = patchBody(item, values[item.sourceId]);
    assertNoUuid({ url: '/api/v1/bacnet/local', body });
    try {
      await http.patch('/api/v1/bacnet/local', body);
    } catch (err) {
      throw new Error(`UpdateLocalObject ${item.objectType} ${item.instance} ${item.name}: ${httpErrorMessage(err)}`);
    }
    patched += 1;
  }
  let tagged = 0;
  const tags = tagPayload(cat, listing, planned, toCreate);
  if (tags.length && typeof http.post === 'function' && (ctx && ctx.skipTags) !== true && toCreate.length === 0) {
    const modelTags = tags.filter(isModelRecord);
    const pointTags = tags.filter((t) => !isModelRecord(t));
    const tagLimit = (ctx && ctx.tagLimit) || await tagBatchSize(http, tags.length);
    const batch = modelTags.concat(sliceRotate(pointTags, tagLimit, now));
    for (const row of batch) {
      const model = row.pointType === 'SITE' || row.pointType === 'EQUIPMENT';
      if (!model && row.uuid && !String(row.name || '').startsWith(NAME_PREFIX)) {
        throw new Error('refusing to upsert a uuid for a name this hook did not create');
      }
    }
    try {
      await http.post('/api/v1/point/points', { points: batch });
      tagged = batch.length;
    } catch (err) {
      throw new Error(`Upsert tags: ${httpErrorMessage(err)}`);
    }
  }
  /** @type {{ bound: number, equipment: number } | null} */
  let siteConfig = null;
  if (layout === 'office' && ctx && typeof ctx.stateRoot === 'string' && toCreate.length === 0) {
    // Bind the functional tests to the objects this hook owns, so they run against the sim with no hand-made config.
    /** @type {number | null} */
    let priority = null;
    try {
      const env = unwrap(await http.get('/api/v1/platform/env?name=BACNET_PRIORITY'));
      const hit = ((env && env.variables) || []).find((/** @type {any} */ x) => x && (x.id === 'BACNET_PRIORITY' || x.name === 'BACNET_PRIORITY'));
      const n = hit ? Number(hit.integer !== undefined ? hit.integer : hit.string) : NaN;
      if (Number.isInteger(n)) priority = n;
    } catch {
      /* older NF: the default priority 12 */
    }
    const built = simSiteConfig.build(cat, listing, { priority });
    if (built) {
      simSiteConfig.save(ctx.stateRoot, built.config);
      siteConfig = { bound: built.bound, equipment: built.config.equipment.length };
    }
  }
  return {
    ok: true,
    created,
    patched,
    tagged,
    site_config: siteConfig,
    pending_creates: planned.create.length - toCreate.length,
    pending_patches: Math.max(0, patchable.length - toPatch.length),
    layout,
    skipped_objects: planned.skip.length,
    points: cat.points.length,
  };
}

/**
 * SITE and EQUIPMENT rows have no BACnet object behind them: they are tagged on every tick. Point rows rotate.
 * @param {{ pointType?: string }} row
 */
function isModelRecord(row) {
  return row.pointType === 'SITE' || row.pointType === 'EQUIPMENT';
}

/**
 * How many point tag rows to upsert this tick: TAG_POINT_BATCH once the model layer holds a record for every
 * site, equipment and point row, TAG_POINT_BATCH_CATCHUP while records are still missing. A failed count falls
 * back to the steady batch.
 * @param {any} http
 * @param {number} expectedRecords
 */
async function tagBatchSize(http, expectedRecords) {
  try {
    const res = await http.post('/api/v1/point/query', { layer: 'model', page_size: 1 });
    const body = unwrap(res);
    const have = Number(body && body.totalCount);
    if (Number.isFinite(have) && have < expectedRecords) return TAG_POINT_BATCH_CATCHUP;
  } catch (_err) {
    // keep the steady batch
  }
  return TAG_POINT_BATCH;
}

/**
 * Haystack attrs for our equipment and points. uuids are omitted unless already known
 * for a name this hook created.
 * @param {any} cat
 * @param {any} listing
 * @param {any} planned
 * @param {any[]} createdThisTick
 */
function tagPayload(cat, listing, planned, createdThisTick) {
  /** @type {any[]} */
  const out = [];
  out.push({
    uuid: stableUuid(`site:${cat.site.id}`),
    name: cat.site.dis,
    layer: 'model',
    pointType: 'SITE',
    attrs: { id: cat.site.id, dis: cat.site.dis, markers: cat.site.markers },
  });
  for (const e of cat.equipment) {
    /** @type {Record<string, string>} */
    const attrs = { id: e.id, dis: e.dis, markers: e.markers, siteRef: e.siteRef };
    if (e.airRef) attrs.airRef = e.airRef;
    if (e.feeds) attrs.feeds = e.feeds;
    if (e.isFedBy) attrs.isFedBy = e.isFedBy;
    if (e.floor) attrs.floor = e.floor;
    if (e.extra) Object.assign(attrs, e.extra);
    out.push({
      uuid: stableUuid(`equip:${e.id}`),
      name: e.dis,
      layer: 'model',
      pointType: 'EQUIPMENT',
      attrs,
    });
  }
  const createdNames = new Set((createdThisTick || []).map((x) => x.name));
  const ours = new Set([...(planned.patch || []).map((/** @type {any} */ p) => p.name), ...createdNames]);
  for (const p of cat.points) {
    if (!ours.has(p.name) && planned.create.some((/** @type {any} */ c) => c.name === p.name)) continue;
    const attrs = {
      id: p.sourceId.startsWith(ID_PREFIX) ? p.sourceId : ID_PREFIX + p.sourceId,
      dis: p.dis,
      markers: p.markers,
      siteRef: p.siteRef,
      equipRef: p.equipRef,
    };
    if (p.kind) attrs.kind = p.kind;
    if (p.unit) attrs.unit = p.unit;
    if (p.simOnly) /** @type {any} */ (attrs).nfftSimOnly = 'true';
    if (p.roleRef) /** @type {any} */ (attrs).roleRef = p.roleRef;
    /** @type {{ name: string, layer: string, attrs: any, uuid?: string }} */
    // Haystack tags live in the model layer. A row without a layer is accepted by NF 3.10 and tags nothing.
    const row = { name: p.name, layer: 'model', attrs, uuid: ownedUuid(listing, p.name) || stableUuid(`point:${p.name}`) };
    out.push(row);
  }
  return out;
}

module.exports = {
  CONFIRM_PHRASE,
  NAME_PREFIX,
  ID_PREFIX,
  SITE_ID,
  TAG_NAMESPACE,
  INSTANCE_BASE,
  isUuid,
  stableUuid,
  PATCH_BATCH,
  TAG_POINT_BATCH,
  TAG_POINT_BATCH_CATCHUP,
  tagBatchSize,
  isModelRecord,
  sliceRotate,
  ownedUuid,
  unwrapOption,
  bacnetUnits,
  isArmed,
  simId,
  catalog,
  demoRecords,
  indexLocal,
  planSync,
  createBody,
  patchBody,
  stepPhysics,
  initialValues,
  currentValues,
  stepOffice,
  OFFICE_CREATE_BATCH,
  OFFICE_FAN,
  OFFICE_PATCH_BATCH,
  assertNoUuid,
  tagPayload,
  run,
};
