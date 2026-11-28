/**
 * Overview dashboard model: groups the NF model layer into equipment cards (air handlers, plants, VAV boxes by floor),
 * picks each card's key readings by Haystack markers, and says whether each piece of equipment can run the AHU or
 * the VAV max-cooling test, and what is missing when it cannot. Fault and FDD result points are left out. SI values
 * in, display conversion to imperial on request. No DOM. Browser global NfftOverviewModel; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftOverviewModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const markersOf = (/** @type {any} */ t) => String(t || '').split(/[,\s]+/).map((m) => m.trim()).filter(Boolean);
  const has = (/** @type {string[]} */ m, /** @type {string[]} */ need) => need.every((x) => m.includes(x));

  /** Card readings. `need` markers must all be present, `not` markers must be absent. First match wins. */
  const READINGS = {
    ahu: [
      { key: 'sat', label: 'Supply air', need: ['discharge', 'air', 'temp', 'sensor'], q: 'temp' },
      { key: 'satSp', label: 'Supply air setpoint', need: ['discharge', 'air', 'temp', 'sp'], q: 'temp' },
      { key: 'static', label: 'Duct static', need: ['discharge', 'air', 'pressure', 'sensor'], q: 'pa' },
      { key: 'staticSp', label: 'Static setpoint', need: ['discharge', 'air', 'pressure', 'sp'], q: 'pa' },
      { key: 'fan', label: 'Supply fan speed', need: ['fan', 'speed'], not: ['return', 'exhaust'], q: 'pct', prefer: ['sensor'] },
      { key: 'fanStatus', label: 'Supply fan', need: ['fan', 'run', 'sensor'], q: 'bool' },
      { key: 'oat', label: 'Outdoor air', need: ['outside', 'air', 'temp', 'sensor'], q: 'temp' },
      { key: 'mat', label: 'Mixed air', need: ['mixed', 'air', 'temp', 'sensor'], q: 'temp' },
      { key: 'rat', label: 'Return air', need: ['return', 'air', 'temp', 'sensor'], q: 'temp' },
      { key: 'oaDamper', label: 'OA damper', need: ['outside', 'damper'], q: 'pct', prefer: ['sensor'] },
      { key: 'cooling', label: 'Cooling', need: ['cool'], not: ['sp'], q: 'pct', prefer: ['sensor'] },
      { key: 'heating', label: 'Heating', need: ['heat', 'valve'], q: 'pct', prefer: ['sensor'] },
    ],
    plant: [
      { key: 'hws', label: 'HW supply', need: ['hot', 'water', 'leaving', 'temp'], q: 'temp' },
      { key: 'hwr', label: 'HW return', need: ['hot', 'water', 'entering', 'temp'], q: 'temp' },
      { key: 'dp', label: 'Loop DP', need: ['water', 'delta', 'pressure', 'sensor'], q: 'kpa' },
      { key: 'pump', label: 'Pump speed', need: ['pump', 'speed'], q: 'pct' },
      { key: 'boiler', label: 'Boiler firing', need: ['boiler'], not: ['temp', 'pressure'], q: 'pct' },
    ],
    vav: [
      { key: 'zat', label: 'Zone', need: ['zone', 'air', 'temp', 'sensor'], q: 'temp' },
      { key: 'zatSp', label: 'Setpoint', need: ['zone', 'air', 'temp', 'sp'], q: 'temp' },
      { key: 'flow', label: 'Airflow', need: ['air', 'flow', 'sensor'], not: ['max', 'min'], q: 'flow' },
      { key: 'flowSp', label: 'Flow setpoint', need: ['air', 'flow', 'sp'], not: ['max', 'min'], q: 'flow' },
      { key: 'flowMax', label: 'Max flow', need: ['max', 'air', 'flow', 'sp'], q: 'flow' },
      { key: 'damper', label: 'Damper', need: ['damper'], not: ['outside', 'return'], q: 'pct', prefer: ['sensor'] },
      { key: 'reheat', label: 'Reheat', need: ['heat', 'cmd'], q: 'pct' },
      { key: 'dat', label: 'Discharge', need: ['discharge', 'air', 'temp', 'sensor'], q: 'temp' },
    ],
  };

  /** A latest value as a number: NF {double|float|int|boolean}, plain numbers and booleans. */
  function scalar(/** @type {any} */ v) {
    let x = v;
    for (let i = 0; i < 3 && x && typeof x === 'object'; i += 1) {
      const k = ['value', 'double', 'float', 'real', 'integer', 'int', 'unsigned', 'boolean', 'bool', 'enumerated'].find((key) => key in x);
      x = k ? x[k] : null;
    }
    if (x === true || x === 'true' || x === 'active') return 1;
    if (x === false || x === 'false' || x === 'inactive') return 0;
    if (x === null || x === undefined || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  /** @param {any} v @returns {string|null} */
  function tsOf(v) {
    return v && typeof v === 'object' && typeof v.ts === 'string' ? v.ts : null;
  }

  /** Input values are converted to SI from the point's own unit. */
  function toSI(/** @type {string} */ q, /** @type {number} */ v, /** @type {string} */ unit) {
    const u = String(unit || '').trim();
    if (q === 'temp' && /°?F$|degF|fahrenheit/i.test(u)) return (v - 32) / 1.8;
    if (q === 'flow' && /cfm|ft³\/min|ft3\/min/i.test(u)) return v * 0.471947;
    if (q === 'pa' && /in\s*h|inH2O|inwc/i.test(u)) return v * 249.0889;
    if (q === 'kpa' && /psi|lbf/i.test(u)) return v * 6.894757;
    if (q === 'kpa' && /^Pa$/.test(u)) return v / 1000;
    return v;
  }

  /** Display text, SI default, imperial on request. @param {string} q @param {number|null} v @param {'si'|'imperial'} units */
  function format(q, v, units) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const imp = units === 'imperial';
    switch (q) {
      case 'temp': return imp ? `${(v * 1.8 + 32).toFixed(1)} °F` : `${v.toFixed(1)} °C`;
      case 'flow': return imp ? `${Math.round(v / 0.471947)} cfm` : `${Math.round(v)} L/s`;
      case 'pa': return imp ? `${(v / 249.0889).toFixed(2)} in. w.c.` : `${Math.round(v)} Pa`;
      case 'kpa': return imp ? `${(v / 6.894757).toFixed(1)} psi` : `${v.toFixed(1)} kPa`;
      case 'pct': return `${Math.round(v)} %`;
      case 'bool': return v >= 0.5 ? 'On' : 'Off';
      default: return String(v);
    }
  }

  /** @param {any[]} points @param {any} spec */
  function pick(points, spec) {
    const hits = points.filter((p) => has(p.markers, spec.need) && !(spec.not || []).some((/** @type {string} */ m) => p.markers.includes(m)));
    if (!hits.length) return null;
    const preferred = (spec.prefer || []).length ? hits.find((p) => spec.prefer.every((/** @type {string} */ m) => p.markers.includes(m))) : null;
    return preferred || hits[0];
  }

  const kindOf = (/** @type {string[]} */ m) => (m.includes('ahu') ? 'ahu' : (m.includes('vav') || m.includes('airTerminalUnit')) ? 'vav'
    : (m.includes('plant') || m.includes('boiler') || m.includes('chiller') || m.includes('pump')) ? 'plant' : 'other');

  /** Test readiness by the same rules the planner uses, read from markers. */
  function readiness(/** @type {string} */ kind, /** @type {any[]} */ points) {
    const find = (/** @type {string[]} */ need, /** @type {string[]} */ [not] = []) => points.find((p) => has(p.markers, need) && !(not ? [not] : []).some((x) => p.markers.includes(x)));
    const writable = (/** @type {any} */ p) => !!p && p.markers.includes('writable');
    /** @type {string[]} */
    const missing = [];
    if (kind === 'ahu') {
      for (const [need, label] of /** @type {[string[], string][]} */ ([
        [['discharge', 'air', 'temp', 'sensor'], 'supply air temperature'], [['mixed', 'air', 'temp', 'sensor'], 'mixed air temperature'],
        [['return', 'air', 'temp', 'sensor'], 'return air temperature'], [['outside', 'air', 'temp', 'sensor'], 'outdoor air temperature'],
        [['discharge', 'air', 'pressure', 'sensor'], 'duct static pressure'], [['fan', 'run', 'sensor'], 'supply fan status'],
      ])) if (!find(need)) missing.push(label);
      if (!writable(find(['cool', 'valve', 'cmd']))) missing.push('writable cooling command');
      if (!writable(find(['heat', 'valve', 'cmd']))) missing.push('writable heating command');
      if (!writable(find(['outside', 'damper', 'cmd']))) missing.push('writable OA damper command');
      return { test: 'AHU functional test', ok: missing.length === 0, missing };
    }
    if (kind === 'vav') {
      const sp = points.find((p) => has(p.markers, ['air', 'flow', 'sp']) && !p.markers.includes('max') && !p.markers.includes('min'));
      if (!sp) missing.push('airflow setpoint');
      else if (!writable(sp)) missing.push('airflow setpoint is not writable');
      if (!points.find((p) => has(p.markers, ['air', 'flow', 'sensor']))) missing.push('airflow sensor');
      return { test: 'VAV max cooling', ok: missing.length === 0, missing };
    }
    return { test: '', ok: false, missing: [] };
  }

  /**
   * Group model records into equipment cards.
   * @param {any[]} records model-layer rows (EQUIPMENT and POINT) with latestValue
   * @param {{ now?: number, staleMs?: number }} [opts]
   */
  function summarize(records, opts) {
    const now = (opts && opts.now) || Date.now();
    const staleMs = (opts && opts.staleMs) || 15 * 60000;
    /** @type {Map<string, any>} */
    const equips = new Map();
    /** @type {Map<string, any[]>} */
    const pointsBy = new Map();
    let site = '';
    for (const r of records || []) {
      const a = r.attrs || {};
      const m = markersOf(a.markers);
      if (r.pointType === 'SITE') { site = site || a.dis || r.name || ''; continue; }
      if (r.pointType === 'EQUIPMENT' || (m.includes('equip') && !a.equipRef)) {
        const id = a.id || r.name;
        equips.set(id, { id, label: a.dis || r.name || id, markers: m, kind: kindOf(m), airRef: a.airRef || '', floor: a.floor || '', site: a.siteRef || '' });
        continue;
      }
      if (!a.equipRef || m.includes('fdd') || m.includes('fault') || a.application_id === 'open-fdd' || a.type === 'fdd-result') continue;
      const list = pointsBy.get(a.equipRef) || [];
      list.push({ uuid: r.uuid, id: a.id || r.name, label: a.dis || r.name, markers: m, unit: a.unit || '', value: scalar(r.latestValue), ts: tsOf(r.latestValue), simOnly: a.nfftSimOnly === 'true' });
      pointsBy.set(a.equipRef, list);
    }
    const cards = [...equips.values()].map((e) => {
      const pts = pointsBy.get(e.id) || [];
      const specs = /** @type {any} */ (READINGS)[e.kind] || [];
      const readings = specs.map((/** @type {any} */ s) => {
        const p = pick(pts, s);
        const v = p && p.value !== null ? toSI(s.q, p.value, p.unit) : null;
        return { key: s.key, label: s.label, q: s.q, value: v, point: p ? p.label : null, simOnly: !!(p && p.simOnly) };
      }).filter((/** @type {any} */ r) => r.point);
      const fresh = pts.map((p) => (p.ts ? Date.parse(p.ts) : NaN)).filter(Number.isFinite);
      const newest = fresh.length ? Math.max(...fresh) : null;
      return {
        ...e, points: pts.length, simOnly: pts.filter((p) => p.simOnly).length, readings,
        stale: newest === null ? true : now - newest > staleMs, newest,
        ready: readiness(e.kind, pts),
      };
    // Equipment the model no longer types (retired sim rows, untyped leftovers) only shows while it still reports.
    }).filter((c) => !c.markers.includes('retired') && (c.kind !== 'other' || (c.points > 0 && !c.stale)));
    cards.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.floor).localeCompare(String(b.floor)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const ahus = cards.filter((c) => c.kind === 'ahu');
    const vavs = cards.filter((c) => c.kind === 'vav');
    /** @type {Record<string, any[]>} */
    const floors = {};
    for (const v of vavs) (floors[v.floor || '—'] = floors[v.floor || '—'] || []).push(v);
    return {
      site, ahus, plants: cards.filter((c) => c.kind === 'plant'), vavs, floors, other: cards.filter((c) => c.kind === 'other'),
      counts: { equipment: cards.length, vavs: vavs.length, ahus: ahus.length, ready: cards.filter((c) => c.ready.ok).length, notReady: cards.filter((c) => c.ready.test && !c.ready.ok).length },
    };
  }

  /** Zone temperature state for colouring: cold / ok / warm, 1 K band. @param {any} card */
  function zoneState(card) {
    const r = Object.fromEntries(card.readings.map((/** @type {any} */ x) => [x.key, x.value]));
    if (r.zat === null || r.zat === undefined) return 'unknown';
    const sp = r.zatSp === null || r.zatSp === undefined ? 22 : r.zatSp;
    if (r.zat > sp + 1) return 'warm';
    if (r.zat < sp - 1) return 'cold';
    return 'ok';
  }

  /** Readings of a card by key. @param {any} card */
  const byKey = (card) => Object.fromEntries((card.readings || []).map((/** @type {any} */ x) => [x.key, x]));

  return { READINGS, summarize, readiness, format, toSI, scalar, zoneState, byKey, markersOf };
});
