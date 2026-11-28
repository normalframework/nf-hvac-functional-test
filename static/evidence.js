/**
 * Functional-test evidence: pass/fail checks over one-minute trend samples taken while the existing hooks ran a
 * sequence, the fan operating point on the design fan curve, the per-box override strategy, and a config/plan
 * fingerprint for the sim-to-live sign-off. Pure functions, no DOM, no NF calls.
 * Browser global NfftEvidence; CommonJS for the harness, the admin hook and tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftEvidence = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 'nfft-evidence/1';
  /** Sensor tolerances: 0.5 K class temperature sensors, so two sensors agree within 1 K. */
  const TOL = Object.freeze({ tempPairK: 1.0, fanHeatMinK: 0.0, fanHeatMaxK: 2.0, damperClosedPct: 5, staticFrac: 0.1, staticMinPa: 25, headroomPct: 95, flowLow: 0.85, flowHigh: 1.1 });

  /** Stable JSON: keys sorted at every level. @param {any} v @returns {string} */
  function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  }

  /**
   * What the sign-off covers: the plan, limits, interlocks, write policy, VAV test settings and, per equipment, its
   * type and the roles it is bound to. Point uuids, layers and equipment ids are left out, so a sim run and a live
   * site with the same plan and the same role coverage share one fingerprint.
   * @param {any} config site config
   */
  function planFingerprint(config) {
    const c = config || {};
    const equipment = (c.equipment || []).map((/** @type {any} */ e) => ({
      type: e.type,
      roles: Object.keys(e.points || {}).sort(),
      writable: Object.entries(e.points || {}).filter(([, b]) => /** @type {any} */ (b).writable === true).map(([r]) => r).sort(),
      serves: Array.isArray(e.serves) ? e.serves.length : 0,
    })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    return canonical({ plan: c.plan || null, limits: c.limits || null, interlocks: c.interlocks || null, write: c.write || null, vav_test: c.vav_test || null, equipment });
  }

  /** @param {number[]} xs */
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  /** @param {any} v */
  const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  /** @param {number|null} v @param {number} [d] */
  const r = (v, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

  /**
   * Samples inside [from, to] (ms). Each sample is { t, v: { 'equip:role': number } }.
   * @param {any[]} samples @param {number} from @param {number} to
   */
  function window(samples, from, to) {
    return (samples || []).filter((s) => s.t >= from && s.t <= to);
  }

  /** Mean of one key over samples, ignoring gaps. @param {any[]} rows @param {string} key */
  function avg(rows, key) {
    return mean(rows.map((s) => n(s.v[key])).filter((x) => x !== null));
  }

  /** @param {string} id @param {string} label @param {boolean|null} pass @param {string} detail @param {any} [extra] */
  function check(id, label, pass, detail, extra) {
    return { id, label, pass, status: pass === null ? 'no_data' : pass ? 'pass' : 'fail', detail, ...(extra || {}) };
  }

  /**
   * ahu.recirc: outdoor air damper closed, so mixed air is return air and discharge is mixed air plus fan heat.
   * @param {any[]} rows hold-window samples
   * @param {string} ahu site-config equipment id
   */
  function recircChecks(rows, ahu) {
    const k = (/** @type {string} */ role) => `${ahu}:${role}`;
    const rat = avg(rows, k('return_air_temperature'));
    const mat = avg(rows, k('mixed_air_temperature'));
    const dat = avg(rows, k('discharge_air_temperature'));
    const oa = avg(rows, k('outdoor_air_intake_damper_position'));
    const out = [];
    out.push(oa === null
      ? check('recirc.oa_damper', 'Outdoor air damper closed (feedback)', null, 'No damper feedback point on this unit.')
      : check('recirc.oa_damper', 'Outdoor air damper closed (feedback)', oa <= TOL.damperClosedPct, `Mean feedback ${r(oa)}% (closed is at most ${TOL.damperClosedPct}%).`, { value: r(oa) }));
    out.push(rat === null || mat === null
      ? check('recirc.rat_mat', 'Mixed air equals return air', null, 'Missing return or mixed air temperature.')
      : check('recirc.rat_mat', 'Mixed air equals return air', Math.abs(rat - mat) <= TOL.tempPairK, `RAT ${r(rat)} °C, MAT ${r(mat)} °C, difference ${r(Math.abs(rat - mat), 2)} K (sensor tolerance ${TOL.tempPairK} K).`, { value: r(mat - rat, 2) }));
    const rise = dat !== null && mat !== null ? dat - mat : null;
    out.push(rise === null
      ? check('recirc.fan_heat', 'Discharge air equals mixed air plus fan heat', null, 'Missing discharge or mixed air temperature.')
      : check('recirc.fan_heat', 'Discharge air equals mixed air plus fan heat', rise >= TOL.fanHeatMinK - TOL.tempPairK / 2 && rise <= TOL.fanHeatMaxK, `DAT − MAT = ${r(rise, 2)} K, expected ${TOL.fanHeatMinK} to ${TOL.fanHeatMaxK} K of fan heat with coils off.`, { value: r(rise, 2) }));
    return out;
  }

  /**
   * Fan operating point on the design curve: fan pressure from the curve at the measured speed and the summed box
   * airflow (no airflow station on this unit). curve: { p0, a } with dP = s^2 p0 - a Q^2, or design points.
   * @param {number|null} flowM3s @param {number|null} speedPct @param {{ p0: number, a: number, designFlowM3s?: number, designPressurePa?: number, eta?: number, source?: string }} curve
   */
  function operatingPoint(flowM3s, speedPct, curve) {
    if (flowM3s === null || speedPct === null || !curve) return null;
    const s = speedPct / 100;
    const dp = Math.max(0, s * s * curve.p0 - curve.a * flowM3s * flowM3s);
    const points = [];
    const qMax = Math.sqrt(curve.p0 / curve.a);
    for (let i = 0; i <= 20; i += 1) {
      const q = (qMax * i) / 20;
      points.push({ q: r(q, 2), full: r(Math.max(0, curve.p0 - curve.a * q * q), 0), now: r(Math.max(0, s * s * curve.p0 - curve.a * q * q), 0) });
    }
    return {
      flow_m3s: r(flowM3s, 2), speed_pct: r(speedPct), pressure_pa: r(dp, 0),
      power_kw: curve.eta ? r((flowM3s * dp) / curve.eta / 1000, 2) : null,
      design_flow_m3s: curve.designFlowM3s || null, design_pressure_pa: curve.designPressurePa || null,
      flow_frac_of_design: curve.designFlowM3s ? r(flowM3s / curve.designFlowM3s, 3) : null,
      source: curve.source || 'illustrative teaching fan (not an EnergyPlus run)', curve: points,
    };
  }

  /**
   * vav.max_cool: every testable box at its cooling maximum; the AHU must hold duct static with fan speed to spare and
   * the summed box airflow should be near the fan's design flow.
   * @param {any[]} rows hold-window samples (last minutes of the hold)
   * @param {{ ahu: string, boxes: { id: string, strategy: string, ok?: boolean, reason?: string|null }[], curve?: any }} ctx
   */
  function maxCoolChecks(rows, ctx) {
    const k = (/** @type {string} */ e, /** @type {string} */ role) => `${e}:${role}`;
    const dsp = avg(rows, k(ctx.ahu, 'discharge_air_static_pressure'));
    const sp = avg(rows, k(ctx.ahu, 'discharge_air_static_pressure_setpoint'));
    const speed = avg(rows, k(ctx.ahu, 'supply_fan_speed_feedback')) ?? avg(rows, k(ctx.ahu, 'supply_fan_speed_command'));
    const boxes = (ctx.boxes || []).map((b) => {
      const flow = avg(rows, k(b.id, 'discharge_air_volume_flow_rate'));
      const max = avg(rows, k(b.id, 'discharge_air_volume_flow_rate_maximum'));
      const tested = b.ok !== false && b.strategy !== 'unsupported';
      const ratio = flow !== null && max ? flow / max : null;
      return { id: b.id, strategy: b.strategy, tested, reason: b.reason || null, flow_lps: r(flow), max_lps: r(max), ratio: r(ratio, 3), pass: tested ? (ratio === null ? null : ratio >= 0.9) : null };
    });
    const tested = boxes.filter((b) => b.tested);
    const sum = tested.reduce((t, b) => t + (b.flow_lps || 0), 0) / 1000;
    const sumMax = tested.reduce((t, b) => t + (b.max_lps || 0), 0) / 1000;
    const out = [];
    const tol = sp === null ? null : Math.max(TOL.staticMinPa, TOL.staticFrac * sp);
    out.push(dsp === null || sp === null || tol === null
      ? check('max_cool.static', 'AHU holds the duct static setpoint', null, 'Missing duct static or its setpoint.')
      : check('max_cool.static', 'AHU holds the duct static setpoint', Math.abs(dsp - sp) <= tol, `Static ${r(dsp, 0)} Pa against ${r(sp, 0)} Pa (± ${r(tol, 0)} Pa).`, { value: r(dsp, 0) }));
    out.push(speed === null
      ? check('max_cool.headroom', 'Supply fan has speed headroom', null, 'No fan speed point.')
      : check('max_cool.headroom', 'Supply fan has speed headroom', speed < TOL.headroomPct, `Fan speed ${r(speed)}% (headroom means below ${TOL.headroomPct}%).`, { value: r(speed) }));
    const design = ctx.curve && ctx.curve.designFlowM3s ? ctx.curve.designFlowM3s : sumMax;
    const frac = design ? sum / design : null;
    out.push(frac === null
      ? check('max_cool.total_flow', 'Summed box airflow near design flow', null, 'No box airflow.')
      : check('max_cool.total_flow', 'Summed box airflow near design flow', frac >= TOL.flowLow && frac <= TOL.flowHigh, `Sum of ${tested.length} tested boxes ${r(sum, 2)} m³/s against ${r(design, 2)} m³/s design (${r(frac * 100, 0)}%; ${TOL.flowLow * 100}–${TOL.flowHigh * 100}% passes).`, { value: r(sum, 2) }));
    const starved = tested.filter((b) => b.pass === false);
    out.push(check('max_cool.boxes', 'Each tested box reaches 90% of its maximum', tested.length ? starved.length === 0 : null,
      tested.length ? (starved.length ? `${starved.length} of ${tested.length} short: ${starved.map((b) => `${b.id} ${r((b.ratio || 0) * 100, 0)}%`).join(', ')}.` : `All ${tested.length} tested boxes reached 90%.`) : 'No testable boxes.'));
    const counts = /** @type {Record<string, number>} */ ({});
    for (const b of boxes) counts[b.strategy] = (counts[b.strategy] || 0) + 1;
    return { checks: out, boxes, strategies: counts, operating_point: operatingPoint(sum, speed, ctx.curve) };
  }

  /**
   * The verdict of a sequence: pass when no check failed and at least one check had data. A box that failed is a
   * finding on the building, not on the hooks; the hooks pass when they ran, wrote, held and released cleanly.
   * @param {any[]} checks
   */
  function verdict(checks) {
    const withData = checks.filter((c) => c.pass !== null);
    if (!withData.length) return 'no_data';
    return withData.every((c) => c.pass) ? 'pass' : 'fail';
  }

  /** CSV of the minute trend. @param {any[]} samples @param {string[]} keys */
  function trendCsv(samples, keys) {
    const head = ['time_utc', ...keys].join(',');
    const lines = samples.map((s) => [new Date(s.t).toISOString(), ...keys.map((k) => (n(s.v[k]) === null ? '' : String(n(s.v[k]))))].join(','));
    return [head, ...lines].join('\n') + '\n';
  }

  /**
   * Can the live target be armed? Only with a signed-off sim run of the same plan fingerprint.
   * @param {any[]} signoffs stored sign-offs
   * @param {string} fingerprintHash hash of planFingerprint(live config)
   */
  function liveGate(signoffs, fingerprintHash) {
    const match = (signoffs || []).filter((s) => s && s.plan_hash === fingerprintHash && s.verdict === 'pass');
    if (match.length) return { ok: true, signoff: match[match.length - 1] };
    return { ok: false, code: 'sim_signoff_required', message: 'Live writes need a passed simulation run of this exact plan and role coverage first.' };
  }

  return { SCHEMA, TOL, canonical, planFingerprint, window, avg, recircChecks, maxCoolChecks, operatingPoint, verdict, trendCsv, liveGate };
});
