/**
 * Operating point model: find the pumps and fans in the data model, resolve the points each panel needs
 * (by 223P role through NfftHaystackBind, else by Haystack marker set), list what is missing, and compute
 * the operating point from the latest values. No DOM. Browser global NfftOpModel; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./oppoint-math.js'));
  else /** @type {any} */ (root).NfftOpModel = factory(/** @type {any} */ (root).NfftOpMath);
})(typeof self !== 'undefined' ? self : this, function (/** @type {any} */ M) {
  'use strict';

  /** Water media. `words` are the Haystack markers of that medium on a point; `tag` prefixes the missing-tag text. */
  const MEDIA = /** @type {Record<string, { id: string, label: string, words: string[], valve: string[] }>} */ ({
    chw: { id: 'chw', label: 'Chilled water', words: ['chilled', 'water'], valve: ['cool'] },
    hw: { id: 'hw', label: 'Hot water', words: ['hot', 'water'], valve: ['heat'] },
    water: { id: 'water', label: 'Water', words: ['water'], valve: ['cool', 'heat'] },
  });

  /**
   * What a panel needs. `sets` are Haystack marker sets, best first; the first one is the text shown when missing.
   * `roles` are 223P roles of the pinned vocabulary (NfftRoles223p) that also satisfy it. `forbid` markers disqualify.
   * @param {string[]} w medium markers
   */
  function pumpQuantities(w) {
    return [
      { key: 'speed', kind: 'speed', sets: [['pump', 'speed', 'sensor'], ['pump', 'vfd', 'speed', 'sensor'], ['pump', 'speed', 'cmd'], ['pump', 'vfd', 'speed', 'cmd']], roles: [], loop: false },
      { key: 'flow', kind: 'flow', sets: [[...w, 'flow', 'sensor']], roles: w[0] === 'chilled' ? ['chilled_water_volume_flow_rate'] : [], loop: true },
      { key: 'dp', kind: 'pressure', sets: [[...w, 'delta', 'pressure', 'sensor'], [...w, 'differential', 'pressure', 'sensor']], roles: w[0] === 'chilled' ? ['chilled_water_pressure_delta'] : [], loop: true, remote: true },
      { key: 'dpSp', kind: 'pressure', sets: [[...w, 'delta', 'pressure', 'sp'], [...w, 'differential', 'pressure', 'sp']], roles: w[0] === 'chilled' ? ['chilled_water_pressure_delta_setpoint'] : [], loop: true, remote: true },
      { key: 'power', kind: 'power', sets: [['pump', 'elec', 'power', 'sensor'], ['elec', 'power', 'sensor']], roles: ['electric_power'], loop: false },
      { key: 'run', kind: 'status', sets: [['pump', 'run', 'sensor']], roles: ['pump_operating_status', 'chilled_water_pump_operating_status'], loop: false, optional: true },
    ];
  }

  const FAN_FORBID = ['return', 'exhaust', 'outside', 'mixed'];
  const fanQuantities = () => [
    { key: 'speed', kind: 'speed', sets: [['discharge', 'fan', 'vfd', 'speed', 'sensor'], ['discharge', 'fan', 'speed', 'sensor'], ['discharge', 'fan', 'vfd', 'speed', 'cmd'], ['fan', 'vfd', 'speed', 'cmd']], roles: ['supply_fan_speed_command'], forbid: FAN_FORBID },
    { key: 'static', kind: 'pressure', sets: [['discharge', 'air', 'pressure', 'sensor']], roles: ['discharge_air_static_pressure'] },
    { key: 'staticSp', kind: 'pressure', sets: [['discharge', 'air', 'pressure', 'sp']], roles: ['discharge_air_static_pressure_setpoint'] },
    { key: 'flow', kind: 'flow', sets: [['discharge', 'air', 'flow', 'sensor']], roles: ['discharge_air_volume_flow_rate'], derivedFromTerminals: true },
    { key: 'power', kind: 'power', sets: [['discharge', 'fan', 'elec', 'power', 'sensor'], ['fan', 'elec', 'power', 'sensor']], roles: ['supply_fan_electric_power'], forbid: FAN_FORBID },
    { key: 'run', kind: 'status', sets: [['discharge', 'fan', 'run', 'sensor']], roles: ['supply_fan_operating_status'], optional: true },
  ];

  /** @param {any} text */
  const markersOf = (text) => (Array.isArray(text) ? text : String(text || '').split(/[,\s]+/)).map((/** @type {string} */ m) => m.trim()).filter(Boolean);
  /** Normalize an equipment id or label for matching (nfft-sim-ahu-1, AHU-1 -> ahu-1). */
  const norm = (/** @type {any} */ v) => String(v || '').toLowerCase().replace(/^nfft-sim[-.]/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const listOf = (/** @type {any} */ v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(norm).filter(Boolean);

  /**
   * Index NF records: equipment from the model layer, points from either layer (model layer when tagged there).
   * @param {{ model?: any[], points?: any[] }} records
   */
  function index(records) {
    /** @type {any[]} */
    const equips = [];
    /** @type {Map<string, any>} */
    const byUuid = new Map();
    for (const r of [...((records && records.model) || []), ...((records && records.points) || [])]) {
      const a = r.attrs || {};
      const markers = markersOf(a.markers);
      if (r.pointType === 'EQUIPMENT' || (markers.includes('equip') && !a.equipRef)) {
        if (!equips.some((e) => e.id === (a.id || r.name))) equips.push({ id: a.id || r.name, key: norm(a.id || r.name), label: a.dis || r.name || a.id, markers, attrs: a, uuid: r.uuid });
        continue;
      }
      if (!a.equipRef || !markers.length) continue;
      const point = { uuid: r.uuid, id: a.id || r.name, name: r.name, label: a.dis || r.name, markers, unit: a.unit || '', equipRef: a.equipRef, equipKey: norm(a.equipRef), cls: a.cls || '' };
      const have = byUuid.get(r.uuid);
      if (!have || (!have.markers.length && markers.length)) byUuid.set(r.uuid, point);
    }
    /** @type {Map<string, any[]>} */
    const pointsByEquip = new Map();
    for (const p of byUuid.values()) {
      if (!pointsByEquip.has(p.equipKey)) pointsByEquip.set(p.equipKey, []);
      /** @type {any[]} */ (pointsByEquip.get(p.equipKey)).push(p);
    }
    return { equips, pointsByEquip, points: [...byUuid.values()] };
  }

  /**
   * First point of a list that satisfies the quantity. A 223P role (when a vocabulary is given) ranks first, then the marker sets in order.
   * @param {any[]} points
   * @param {any} q quantity definition
   * @param {string[]} equipMarkers
   * @param {{ vocab?: any, bind?: any }} deps
   * @returns {{ point: any, via: string }|null}
   */
  function pick(points, q, equipMarkers, deps) {
    let best = /** @type {{ point: any, via: string, rank: number }|null} */ (null);
    for (const p of points) {
      if ((q.forbid || []).some((/** @type {string} */ m) => p.markers.includes(m))) continue;
      /** @type {number|null} */
      let rank = null;
      let via = '';
      if (deps.vocab && deps.bind && q.roles.length) {
        const r = deps.bind.bindPoint({ markers: p.markers, cls: p.cls }, equipMarkers, deps.vocab).role;
        if (r && q.roles.includes(r)) {
          // A specific role ranks first. The generic electric_power role accepts any power point, so it stays behind the marker sets.
          rank = r === 'electric_power' ? 10 : -1 + q.roles.indexOf(r) * 0.1;
          via = `role ${r}`;
        }
      }
      const si = q.sets.findIndex((/** @type {string[]} */ set) => set.every((m) => p.markers.includes(m)));
      if (si >= 0 && (rank === null || si < rank)) {
        rank = si;
        via = `tags ${q.sets[si].join(' ')}`;
      }
      if (rank !== null && (!best || rank < best.rank)) best = { point: p, via, rank };
    }
    return best ? { point: best.point, via: best.via } : null;
  }

  /** The tags shown for a missing quantity. */
  const needOf = (/** @type {any} */ q) => q.sets[0].join(' ');

  /**
   * @param {any} idx NfftOpModel.index()
   * @param {any} q
   * @param {any} equip the pump or AHU
   * @param {any[]} extra equipment searched after the equipment itself (plant equipment, loop AHUs)
   * @param {any} deps
   */
  function resolveQuantity(idx, q, equip, extra, deps) {
    const own = pick(idx.pointsByEquip.get(equip.key) || [], q, equip.markers, deps);
    if (own) return { key: q.key, kind: q.kind, need: needOf(q), optional: !!q.optional, found: true, point: own.point, via: own.via, equipId: equip.id, remote: false };
    for (const e of extra) {
      const hit = pick(idx.pointsByEquip.get(e.key) || [], q, e.markers, deps);
      if (hit) return { key: q.key, kind: q.kind, need: needOf(q), optional: !!q.optional, found: true, point: hit.point, via: hit.via, equipId: e.id, remote: true };
    }
    return { key: q.key, kind: q.kind, need: needOf(q), optional: !!q.optional, found: false, point: null, via: '', equipId: null, remote: false };
  }

  /** @param {any} equip */
  function mediumOf(equip) {
    const m = new Set(equip.markers);
    if (m.has('chilled') || m.has('chilledWater')) return MEDIA.chw;
    if (m.has('hot') || m.has('hotWater') || m.has('heating')) return MEDIA.hw;
    return MEDIA.water;
  }

  /** Terminals of an AHU: the 223P system when given, else the equipment records (airRef, isFedBy). */
  function terminalsOf(/** @type {any} */ idx, /** @type {any} */ ahu, /** @type {any} */ systems) {
    const sys = (systems || []).find((/** @type {any} */ s) => norm(s.id) === ahu.key);
    if (sys) {
      return (sys.terminals || []).map((/** @type {any} */ t) => idx.equips.find((/** @type {any} */ e) => e.key === norm(t.id)) || { id: t.id, key: norm(t.id), label: t.label || t.id, markers: ['equip', 'vav'], attrs: {} });
    }
    return idx.equips.filter((/** @type {any} */ e) => e.markers.includes('airTerminalUnit') || e.markers.includes('vav')).filter((/** @type {any} */ e) => {
      const refs = [...listOf(e.attrs.airRef), ...listOf(e.attrs.isFedBy)];
      return refs.includes(ahu.key);
    });
  }

  const VALVE_SETS = (/** @type {string[]} */ words) => words.flatMap((w) => [[w, 'valve', 'sensor'], [w, 'valve', 'cmd']]);
  const valveQuantity = (/** @type {any} */ medium, /** @type {boolean} */ reheat) => reheat
    ? { key: 'valve', kind: 'percent', sets: [['reheat', 'valve', 'sensor'], ['reheat', 'valve', 'cmd'], ['reheat', 'cmd']], roles: ['terminal_unit_heating_valve_position_command'] }
    : { key: 'valve', kind: 'percent', sets: VALVE_SETS(medium.valve), roles: medium.id === 'chw' ? ['cooling_valve_position', 'cooling_valve_position_command'] : medium.id === 'hw' ? ['heating_valve_position', 'heating_valve_position_command'] : [] };

  /**
   * Resolve every waterside pump and every air handler fan.
   * @param {{ model?: any[], points?: any[] }} records NF records
   * @param {{ vocab?: any, bind?: any, systems?: any[] }} [deps] vocab/bind: NfftRoles223p and NfftHaystackBind; systems: NfftSystems groups
   */
  function resolve(records, deps = {}) {
    const idx = index(records);
    const ahus = idx.equips.filter((/** @type {any} */ e) => e.markers.includes('ahu'));
    const plantMates = (/** @type {any} */ medium) => idx.equips.filter((/** @type {any} */ e) => !e.markers.includes('pump') && !e.markers.includes('ahu') && !e.markers.includes('vav') && !e.markers.includes('airTerminalUnit')
      && (e.markers.includes('chiller') || e.markers.includes('boiler') || e.markers.includes('plant') || e.markers.includes('loop') || e.markers.includes('header'))
      && (medium.id === 'water' || (medium.id === 'chw' ? !e.markers.includes('boiler') : !e.markers.includes('chiller'))));

    const pumps = idx.equips.filter((/** @type {any} */ e) => e.markers.includes('pump') && !e.markers.includes('condenser') && !e.markers.includes('condenserWater')).map((/** @type {any} */ pump) => {
      const medium = mediumOf(pump);
      const defs = pumpQuantities(medium.words);
      const vq = valveQuantity(medium, false);
      const fed = listOf(pump.attrs.feeds);
      const loopAhus = ahus.filter((/** @type {any} */ a) => (fed.length ? fed.includes(a.key) : !!pick(idx.pointsByEquip.get(a.key) || [], vq, a.markers, deps)));
      const mates = plantMates(medium);
      const q = /** @type {Record<string, any>} */ ({});
      for (const d of defs) q[d.key] = resolveQuantity(idx, d, pump, d.loop ? [...mates, ...(d.remote ? loopAhus : [])] : [], deps);
      const branches = loopAhus.map((/** @type {any} */ a) => {
        const v = resolveQuantity(idx, vq, a, [], deps);
        return { id: a.id, label: a.label, valve: v.found ? v : null };
      });
      /** @type {any[]} */
      const reheat = [];
      if (medium.id !== 'chw') {
        const rq = valveQuantity(medium, true);
        for (const a of loopAhus) {
          for (const t of terminalsOf(idx, a, deps.systems)) {
            const v = resolveQuantity(idx, rq, t, [], deps);
            if (v.found) reheat.push({ id: t.id, label: t.label, ahu: a.id, valve: v });
          }
        }
      }
      const missing = defs.filter((d) => !d.optional && !q[d.key].found).map(needOf);
      if (!branches.some((b) => b.valve) && !reheat.length) missing.push(needOf(vq));
      return {
        kind: 'pump', id: pump.id, label: pump.label, medium: medium.id, mediumLabel: medium.label, attrs: pump.attrs,
        q, missing, branches, reheat,
        equipIds: [...new Set([pump.id, ...Object.values(q).filter((x) => x.found && x.equipId).map((x) => x.equipId), ...loopAhus.map((a) => a.id), ...reheat.map((r) => r.id)])],
      };
    });

    const fans = ahus.map((/** @type {any} */ ahu) => {
      const defs = fanQuantities();
      const q = /** @type {Record<string, any>} */ ({});
      for (const d of defs) q[d.key] = resolveQuantity(idx, d, ahu, [], deps);
      const dq = { key: 'damper', kind: 'percent', sets: [['damper', 'sensor'], ['damper', 'cmd']], roles: ['damper_position', 'damper_position_command'], forbid: ['outside', 'return', 'exhaust', 'mixed'] };
      const fq = { key: 'flow', kind: 'flow', sets: [['discharge', 'air', 'flow', 'sensor']], roles: ['discharge_air_volume_flow_rate'] };
      const terminals = terminalsOf(idx, ahu, deps.systems).map((/** @type {any} */ t) => ({
        id: t.id, label: t.label, damper: resolveQuantity(idx, dq, t, [], deps), flow: resolveQuantity(idx, fq, t, [], deps),
      }));
      let derived = false;
      if (!q.flow.found && terminals.some((t) => t.flow.found)) {
        derived = true;
        q.flow = { ...q.flow, found: true, derived: 'terminals', via: 'sum of VAV discharge air flow sensors' };
      }
      const missing = defs.filter((d) => !d.optional && !q[d.key].found).map(needOf);
      if (terminals.length && !terminals.some((t) => t.damper.found)) missing.push('damper sensor (VAV)');
      return {
        kind: 'fan', id: ahu.id, label: ahu.label, medium: 'air', mediumLabel: 'Air', attrs: ahu.attrs,
        q, missing, terminals, derivedFlow: derived,
        equipIds: [ahu.id, ...terminals.map((t) => t.id)],
      };
    });
    return { pumps, fans, equips: idx.equips.length, points: idx.points.length };
  }

  /** A latest value as a number: plain numbers, booleans, {value}, and NF's {double|float|int|integer|boolean|bool}. */
  function scalar(/** @type {any} */ v) {
    let x = v;
    for (let i = 0; i < 3 && x && typeof x === 'object' && !Array.isArray(x); i += 1) {
      const k = ['value', 'double', 'float', 'integer', 'int', 'uint', 'boolean', 'bool'].find((key) => key in x);
      x = k ? x[k] : null;
    }
    if (x === true || x === 'true') return 1;
    if (x === false || x === 'false') return 0;
    if (x === null || x === undefined || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  /** @param {any} entry @param {Record<string, any>} values uuid -> latest value @param {string} key */
  function readQuantity(entry, values, key) {
    const q = entry.q[key];
    if (!q || !q.found || !q.point) return null;
    const v = scalar(values[q.point.uuid]);
    return v === null ? null : { value: v, unit: q.point.unit || '', point: q.point, via: q.via };
  }

  /** Nameplate from the equipment attributes: design flow, head or pressure, power, curve coefficients, rated speed. */
  function nameplate(/** @type {any} */ entry) {
    const a = entry.attrs || {};
    const fan = entry.kind === 'fan';
    const designFlow = M.toSI('flow', a.designFlow, 'L/s');
    const designHead = M.toSI('pressure', fan ? (a.designPressure !== undefined ? a.designPressure : a.designHead) : a.designHead, fan ? 'Pa' : 'kPa');
    const designPower = M.toSI('power', a.designPower, 'kW');
    // curveCoeffs: "c0,c1,c2": H [kPa for pumps, Pa for fans] = c0 + c1 Q + c2 Q^2, Q in L/s.
    let coeffs = null;
    if (a.curveCoeffs) {
      const raw = String(a.curveCoeffs).split(/[,;\s]+/).filter(Boolean).map(Number);
      if (raw.length >= 2 && raw.every(Number.isFinite)) {
        const hUnit = fan ? 1 : 1000; // Pa per head unit
        coeffs = raw.map((c, i) => c * hUnit * 1000 ** i); // Q [m3/s] = Q [L/s] / 1000, so the Q^i term scales by 1000^i
      }
    }
    return {
      designFlow, designHead, designPower, coeffs,
      ratedHz: Number(a.ratedHz) > 0 ? Number(a.ratedHz) : 60,
      ratedRpm: Number(a.ratedRpm) > 0 ? Number(a.ratedRpm) : null,
      etaBest: Number(a.etaBest) > 0 ? Number(a.etaBest) : null,
      known: !!(designFlow && (designHead || coeffs)),
    };
  }

  /**
   * Operating point of one pump or fan from the latest values. All numbers SI base; see NfftOpMath.
   * Works with missing data: the curve is then generic (normalized, illustrative) and the point is placed by speed alone.
   * @param {any} entry NfftOpModel.resolve() pump or fan
   * @param {Record<string, any>} values point uuid -> latest value
   * @param {{ lib: any, bundle: any, fans: number, pumps: number }} [design] imported design values (NfftDesignValues)
   */
  function compute(entry, values, design) {
    const fan = entry.kind === 'fan';
    const own = nameplate(entry);
    const DV = design && design.lib;
    const item = DV && design.bundle ? DV.forEquipment(design.bundle, entry, fan ? design.fans : design.pumps) : null;
    const np = DV ? DV.merge(own, item, design.bundle ? design.bundle.label : '') : { ...own, sources: { designFlow: own.designFlow ? 'nameplate' : 'missing', designHead: own.designHead ? 'nameplate' : 'missing', designPower: own.designPower ? 'nameplate' : 'missing', coeffs: own.coeffs ? 'nameplate' : 'missing' } };
    const curve = M.makeCurve({ kind: fan ? 'fan' : 'pump', designFlow: np.designFlow, designHead: np.designHead, designPower: np.designPower, coeffs: np.coeffs, etaBest: np.etaBest });
    /** @type {string[]} */
    const notes = [];
    const read = (/** @type {string} */ k) => readQuantity(entry, values, k);

    const sp = read('speed');
    const speedPoint = entry.q.speed && entry.q.speed.point;
    const speedIsCmd = !!(speedPoint && speedPoint.markers.includes('cmd'));
    let s = sp ? M.speedFraction(sp.value, sp.unit, np.ratedHz, np.ratedRpm) : null;
    if (s !== null) s = Math.max(0, Math.min(1.2, s));
    const speedKnown = s !== null;
    if (!speedKnown) notes.push('speed unknown: drawn at 100 percent');
    if (speedKnown && speedIsCmd) notes.push('speed is the command, not a feedback');
    const sUse = speedKnown ? /** @type {number} */ (s) : 1;
    const hz = sp && String(sp.unit).toLowerCase() === 'hz' ? sp.value : (speedKnown ? sUse * np.ratedHz : null);

    /** @param {string} key @param {'flow'|'pressure'|'power'} kind @param {string} dflt */
    const si = (key, kind, dflt) => {
      const r = read(key);
      return r ? M.toSI(kind, r.value, r.unit || dflt) : null;
    };
    const flowDefault = 'L/s';
    let flow = si('flow', 'flow', flowDefault);
    let flowSource = flow !== null ? 'measured' : null;
    if (flow === null && entry.derivedFlow) {
      let sum = 0;
      let seen = 0;
      for (const t of entry.terminals) {
        const r = readQuantity({ q: { f: t.flow } }, values, 'f');
        const v = r ? M.toSI('flow', r.value, r.unit || flowDefault) : null;
        if (v !== null) { sum += v; seen += 1; }
      }
      if (seen) {
        flow = sum;
        flowSource = `sum of ${seen} VAV flow sensor${seen === 1 ? '' : 's'}`;
        if (seen < entry.terminals.length) notes.push(`only ${seen} of ${entry.terminals.length} VAVs report flow`);
      }
    }
    const dp = si(fan ? 'static' : 'dp', 'pressure', fan ? 'Pa' : 'kPa');
    const dpSp = si(fan ? 'staticSp' : 'dpSp', 'pressure', fan ? 'Pa' : 'kPa');
    const powerW = si('power', 'power', 'kW');

    /** @type {{ hStatic: number, k: number, adjusted?: boolean, source: string }} */
    let sys;
    /** @type {{ q: number, h: number, s: number, source: string }|null} */
    let op = null;
    const norm0 = curve.normalized;
    if (!norm0) {
      const hd = curve.designHead;
      let hs = dpSp !== null ? dpSp : dp;
      let hsSource = dpSp !== null ? (fan ? 'static pressure setpoint' : 'DP setpoint') : (dp !== null ? 'measured value (no setpoint)' : 'assumed 30 percent of design');
      if (hs === null) hs = 0.3 * hd;
      if (flow !== null && flow > 0) {
        const h = curve.head(flow, sUse);
        const fit = M.fitSystem({ hStatic: hs, q: flow, h });
        sys = { ...fit, source: hsSource };
        if (fit.adjusted) notes.push('static head limited to 90 percent of the pump head at this flow');
        op = { q: flow, h, s: sUse, source: flowSource || 'measured' };
      } else {
        const fit = M.fitSystem({ hStatic: hs, q: curve.designFlow, h: hd });
        sys = { ...fit, source: `${hsSource}, through the design point` };
        const hit = M.intersect(curve, sUse, sys);
        if (hit) op = { q: hit.q, h: hit.h, s: sUse, source: 'intersection of the curve and the system curve (no flow sensor)' };
      }
    } else {
      // No nameplate: normalized axes (design = 1). A system curve through the design point with a 30 percent static part.
      const fit = M.fitSystem({ hStatic: 0.3, q: 1, h: 1 });
      sys = { ...fit, source: 'generic (30 percent static)' };
      const hit = M.intersect(curve, sUse, sys);
      if (hit) op = { q: hit.q, h: hit.h, s: sUse, source: 'generic curves (no nameplate)' };
    }

    // Power: measured, else from the curve (anchored to the nameplate power when given).
    let powerOut = null;
    let powerSource = null;
    let pscale = 1;
    if (!norm0 && np.designPower) {
      const atDesign = curve.power(curve.designFlow, 1);
      if (atDesign > 0) pscale = np.designPower / atDesign;
    }
    if (powerW !== null) {
      powerOut = powerW;
      powerSource = 'measured';
    } else if (op && !norm0) {
      powerOut = curve.power(op.q, op.s) * pscale;
      powerSource = 'estimated from the curve';
    }
    const cmp = op && !norm0
      ? M.compareFixedSpeed(curve, sys, { q: op.q, h: op.h, s: op.s, powerW: powerW !== null && flow !== null ? powerW : null }, pscale)
      : (op ? M.compareFixedSpeed(curve, sys, { q: op.q, h: op.h, s: op.s, powerW: null }, 1) : null);

    const illustrative = curve.illustrative;
    return {
      entryId: entry.id, kind: entry.kind, curve, illustrative, curveSource: curve.source, designSources: np.sources,
      nameplate: np, speed: { fraction: speedKnown ? sUse : null, hz, command: speedIsCmd, known: speedKnown },
      flow, flowSource, dp, dpSp, powerW: powerOut, powerSource, measuredPower: powerW,
      sys, op, cmp, notes,
      tooltip: illustrative ? 'illustrative' : null,
    };
  }

  /** The "Missing data" line for a panel, or '' when nothing is missing. */
  function missingText(/** @type {any} */ entry) {
    return entry.missing.length ? `Missing data: ${entry.missing.join(', ')}` : '';
  }

  return { MEDIA, index, resolve, compute, nameplate, scalar, readQuantity, missingText, pick, norm, markersOf, pumpQuantities, fanQuantities };
});