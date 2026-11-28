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
function catalog(rec) {
  const records = rec || demoRecords();
  const withExtras = !rec;
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
      if (withExtras && /** @type {any} */ (opoint.EQUIPMENT_ATTRS)[attrs.id]) out.extra = /** @type {any} */ (opoint.EQUIPMENT_ATTRS)[attrs.id];
      return out;
    });
  if (withExtras) {
    for (const e of opoint.EXTRA_EQUIPMENT) {
      const extra = /** @type {any} */ (opoint.EQUIPMENT_ATTRS)[e.id];
      equipment.push({ id: simId(e.id), dis: e.dis, markers: e.markers, siteRef: SITE_ID, kind: e.kind, ...(extra ? { extra } : {}) });
    }
  }
  const site = { id: SITE_ID, dis: 'Functional test bench site', markers: 'site' };
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
  return { site, equipment, points };
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
function stepPhysics(values) {
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
  return stepPhysics(values);
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
 * @param {{ options?: any, http?: any, log?: Function, now?: number, records?: any, createLimit?: number, patchLimit?: number, tagLimit?: number, skipTags?: boolean }} [ctx]
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
  const cat = catalog(ctx && ctx.records);
  const planned = planSync(listing, cat);
  const values = initialValues(cat);
  const now = (ctx && ctx.now) || Date.now();
  const limit = (ctx && ctx.createLimit) || CREATE_BATCH;
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
  const patchLimit = (ctx && ctx.patchLimit) || PATCH_BATCH;
  const toPatch = toCreate.length === 0 ? sliceRotate(planned.patch, patchLimit, now) : [];
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
  return {
    ok: true,
    created,
    patched,
    tagged,
    pending_creates: planned.create.length - toCreate.length,
    pending_patches: Math.max(0, planned.patch.length - toPatch.length),
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
  assertNoUuid,
  tagPayload,
  run,
};
