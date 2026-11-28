/**
 * Operating point math for pumps and fans: pump or fan curve, affinity laws, system curve, intersection.
 * Everything is computed in SI base units (m3/s, Pa, W, speed as a fraction of rated speed).
 * Display helpers convert to L/s, kPa and kW; imperial (gpm, ft, psi, cfm, inH2O, hp) is display-only.
 * Browser global NfftOpMath; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftOpMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = 9.80665; // m/s2
  const RHO_WATER = 998; // kg/m3, chilled and hot water near 10..60 C (display-grade)
  const RHO_AIR = 1.2; // kg/m3

  /** Unit tables: multiplier to the SI base (m3/s, Pa, W). Keys are compared lower case without spaces. */
  const FLOW = { 'm3/s': 1, 'm³/s': 1, 'l/s': 1e-3, 'lps': 1e-3, 'l/min': 1e-3 / 60, 'm3/h': 1 / 3600, 'm³/h': 1 / 3600, 'gpm': 6.30901964e-5, 'cfm': 4.71947443e-4 };
  const PRESSURE = { 'pa': 1, 'kpa': 1000, 'bar': 1e5, 'psi': 6894.757293, 'inh2o': 249.08891, 'inwc': 249.08891, 'inh₂o': 249.08891, 'fth2o': 2989.06692, 'ftwc': 2989.06692, 'mh2o': 9806.65 };
  const POWER = { 'w': 1, 'kw': 1000, 'hp': 745.699872 };
  const TABLES = /** @type {Record<string, Record<string, number>>} */ ({ flow: FLOW, pressure: PRESSURE, power: POWER });

  /**
   * One quantity with a unit to SI base. Bare numbers use the default unit.
   * @param {'flow'|'pressure'|'power'} kind
   * @param {number|string|null|undefined} value a number, or text like "20 L/s"
   * @param {string} defaultUnit
   * @returns {number|null}
   */
  function toSI(kind, value, defaultUnit) {
    if (value === null || value === undefined || value === '') return null;
    let n;
    let unit = defaultUnit;
    if (typeof value === 'number') n = value;
    else {
      const m = /^\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*(.*)$/i.exec(String(value));
      if (!m) return null;
      n = Number(m[1]);
      if (m[2].trim()) unit = m[2];
    }
    if (!Number.isFinite(n)) return null;
    const factor = TABLES[kind][String(unit || '').toLowerCase().replace(/\s+/g, '')];
    return factor === undefined ? null : n * factor;
  }

  /** Display form of an SI value: [number, unit] in SI (L/s, kPa or Pa, kW) or in imperial for the parenthesis. */
  const display = {
    flow: (/** @type {number} */ q) => ({ value: q * 1000, unit: 'L/s' }),
    pressure: (/** @type {number} */ p) => (Math.abs(p) >= 10000 ? { value: p / 1000, unit: 'kPa' } : { value: p, unit: 'Pa' }),
    power: (/** @type {number} */ w) => ({ value: w / 1000, unit: 'kW' }),
  };
  const imperial = {
    waterFlow: (/** @type {number} */ q) => ({ value: q / FLOW.gpm, unit: 'gpm' }),
    airFlow: (/** @type {number} */ q) => ({ value: q / FLOW.cfm, unit: 'cfm' }),
    waterHead: (/** @type {number} */ p) => ({ value: p / PRESSURE.fth2o, unit: 'ft' }),
    airPressure: (/** @type {number} */ p) => ({ value: p / PRESSURE.inh2o, unit: 'in. w.c.' }),
    power: (/** @type {number} */ w) => ({ value: w / POWER.hp, unit: 'hp' }),
  };

  /** @param {number} value @param {number} digits */
  function round(value, digits) {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
  }

  /** Affinity laws between speed fractions: flow ~ s, pressure or head ~ s^2, power ~ s^3. */
  const affinity = {
    flow: (/** @type {number} */ q, /** @type {number} */ s) => q * s,
    head: (/** @type {number} */ h, /** @type {number} */ s) => h * s * s,
    power: (/** @type {number} */ p, /** @type {number} */ s) => p * s * s * s,
  };

  /**
   * Speed fraction from a speed reading.
   * @param {number|null} value
   * @param {string} unit '%', 'Hz', 'rpm' or '' (a fraction up to 1.5, else percent)
   * @param {number} [ratedHz]
   * @param {number} [ratedRpm]
   * @returns {number|null}
   */
  function speedFraction(value, unit, ratedHz, ratedRpm) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const u = String(unit || '').toLowerCase().trim();
    if (u === 'hz') return value / (ratedHz || 60);
    if (u === 'rpm') return ratedRpm ? value / ratedRpm : null;
    if (u === '%' || u === 'percent') return value / 100;
    if (u === 'frac' || u === 'fraction') return value;
    return Math.abs(value) <= 1.5 ? value : value / 100;
  }

  /**
   * Curve with a fixed shape: head (or total pressure) vs flow at rated speed, plus an efficiency curve.
   * Generic shape: H(q) = Hd (1.25 - 0.25 q^2) for pumps, 1.30 - 0.30 q^2 for fans, q = Q / Qd.
   * Efficiency: eta(q) = etaBep (2q - q^2), floored at 15 percent of the best point.
   * @param {{ kind?: 'pump'|'fan', designFlow?: number|null, designHead?: number|null, designPower?: number|null,
   *   coeffs?: number[]|null, etaBest?: number|null }} spec SI base units; coeffs are H(Q) polynomial c0 + c1 Q + c2 Q^2 + ... with Q in m3/s and H in Pa
   */
  function makeCurve(spec) {
    const kind = spec.kind || 'pump';
    const coeffs = spec.coeffs && spec.coeffs.length >= 2 && spec.coeffs.every(Number.isFinite) ? spec.coeffs : null;
    const qd = spec.designFlow && spec.designFlow > 0 ? spec.designFlow : null;
    const hd = spec.designHead && spec.designHead > 0 ? spec.designHead : null;
    const pd = spec.designPower && spec.designPower > 0 ? spec.designPower : null;
    const etaBest = spec.etaBest && spec.etaBest > 0 && spec.etaBest <= 1 ? spec.etaBest : (kind === 'pump' ? 0.75 : 0.65);
    const shut = kind === 'pump' ? 1.25 : 1.3;
    const normalized = !(qd && (hd || coeffs));
    const Qd = normalized ? 1 : /** @type {number} */ (qd);
    let Hd = hd || 1;
    /** @type {(Q: number) => number} */
    let h100;
    /** @type {'coefficients'|'nameplate'|'generic'} */
    let source;
    if (coeffs && !normalized) {
      source = 'coefficients';
      h100 = (Q) => Math.max(0, coeffs.reduce((a, c, i) => a + c * Q ** i, 0));
      Hd = hd || h100(Qd);
    } else if (!normalized) {
      source = 'nameplate';
      h100 = (Q) => Math.max(0, Hd * (shut - (shut - 1) * (Q / Qd) ** 2));
    } else {
      source = 'generic';
      h100 = (Q) => Math.max(0, shut - (shut - 1) * Q * Q);
    }
    // Flow where the curve reaches zero head at rated speed.
    let maxFlow = Qd * Math.sqrt(shut / (shut - 1));
    if (source === 'coefficients') {
      let hi = Qd;
      while (h100(hi) > 0 && hi < Qd * 20) hi *= 1.1;
      maxFlow = hi;
    }
    const eta = (/** @type {number} */ q) => etaBest * Math.max(0.15, 2 * q - q * q);
    return {
      kind,
      source,
      normalized,
      illustrative: source === 'generic',
      designFlow: Qd,
      designHead: Hd,
      designPower: pd,
      etaBest,
      maxFlow,
      /** Head or pressure at flow Q and speed fraction s (affinity: s^2 * H100(Q / s)). */
      head(/** @type {number} */ Q, s = 1) {
        if (s <= 0) return 0;
        return s * s * h100(Q / s);
      },
      /** Efficiency at flow Q and speed s: evaluated at the homologous point Q / s. */
      efficiency(/** @type {number} */ Q, s = 1) {
        if (s <= 0) return etaBest * 0.15;
        return eta(Math.min(Q / s / Qd, 1.6));
      },
      /** Shaft power W: Q H / eta, or scaled from the nameplate power by the affinity laws when known and normalized not set. */
      power(/** @type {number} */ Q, s = 1) {
        if (s <= 0 || Q <= 0) return 0;
        return Q * this.head(Q, s) / this.efficiency(Q, s);
      },
    };
  }

  /**
   * System curve H = Hs + k Q^2 through the operating point (Qop, Hop). Hs is the static part (DP setpoint).
   * @param {{ hStatic: number, q: number, h: number }} p SI base units
   * @returns {{ hStatic: number, k: number, adjusted: boolean }}
   */
  function fitSystem(p) {
    const q = Math.max(p.q, 1e-9);
    let hs = Math.max(0, p.hStatic || 0);
    let adjusted = false;
    // The static part cannot exceed the head the pump delivers at that flow; keep 10 percent for friction.
    if (hs > 0.9 * p.h) {
      hs = 0.9 * p.h;
      adjusted = true;
    }
    return { hStatic: hs, k: Math.max(0, (p.h - hs) / (q * q)), adjusted };
  }

  /** @param {{ hStatic: number, k: number }} sys @param {number} Q */
  const systemHead = (sys, Q) => sys.hStatic + sys.k * Q * Q;

  /**
   * Intersection of the curve at speed s with the system curve (bisection on flow).
   * @param {ReturnType<typeof makeCurve>} curve
   * @param {number} s speed fraction
   * @param {{ hStatic: number, k: number }} sys
   * @returns {{ q: number, h: number }|null} null when the pump cannot reach the static head at that speed
   */
  function intersect(curve, s, sys) {
    if (!(s > 0)) return null;
    const f = (/** @type {number} */ Q) => curve.head(Q, s) - systemHead(sys, Q);
    let lo = 0;
    let hi = curve.maxFlow * s;
    if (f(lo) <= 0) return null;
    if (f(hi) > 0) return { q: hi, h: curve.head(hi, s) };
    for (let i = 0; i < 80; i += 1) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    const q = (lo + hi) / 2;
    return { q, h: curve.head(q, s) };
  }

  /**
   * Sample a curve for charting (speed fraction s). Points are [Q, H] in SI base units.
   * @param {ReturnType<typeof makeCurve>} curve
   * @param {number} s
   * @param {number} [n]
   * @param {number} [qTop] cap on the flow range, so the chart axes stay readable
   */
  function sampleCurve(curve, s, n = 40, qTop = Infinity) {
    const top = Math.min(curve.maxFlow * s, qTop);
    /** @type {[number, number][]} */
    const out = [];
    for (let i = 0; i <= n; i += 1) {
      const Q = (top * i) / n;
      out.push([Q, curve.head(Q, s)]);
    }
    return out;
  }

  /** @param {{ hStatic: number, k: number }} sys @param {number} qMax @param {number} [n] */
  function sampleSystem(sys, qMax, n = 40) {
    /** @type {[number, number][]} */
    const out = [];
    for (let i = 0; i <= n; i += 1) {
      const Q = (qMax * i) / n;
      out.push([Q, systemHead(sys, Q)]);
    }
    return out;
  }

  /**
   * Fixed-speed against variable-speed at the same delivered flow, plus the fixed-speed natural point.
   * "Throttled" is a fixed-speed machine held to the flow by a control valve or damper: it runs at full speed
   * and the valve or damper burns the extra head. "Natural" is that machine wide open on the system curve.
   * @param {ReturnType<typeof makeCurve>} curve
   * @param {{ hStatic: number, k: number }} sys
   * @param {{ q: number, h: number, s: number, powerW?: number|null }} op current point (variable speed)
   * @param {number} [powerScale] factor applied to power so a measured kW anchors the model (measured / modelled at the op point)
   */
  function compareFixedSpeed(curve, sys, op, powerScale = 1) {
    const vfdModel = curve.power(op.q, op.s);
    const scale = op.powerW && vfdModel > 0 ? op.powerW / vfdModel : powerScale;
    const throttledHead = curve.head(op.q, 1);
    const natural = intersect(curve, 1, sys);
    const row = (/** @type {string} */ id, /** @type {string} */ label, /** @type {number} */ q, /** @type {number} */ h, /** @type {number} */ s) => ({ id, label, q, h, s, powerW: curve.power(q, s) * scale });
    const rows = [
      row('vfd', 'Variable speed (now)', op.q, op.h, op.s),
      row('throttled', 'Fixed speed, throttled to the same flow', op.q, throttledHead, 1),
    ];
    if (natural) rows.push(row('natural', 'Fixed speed, wide open', natural.q, natural.h, 1));
    const thr = rows[1];
    const savedW = thr.powerW - rows[0].powerW;
    return { rows, savedW, savedFraction: thr.powerW > 0 ? savedW / thr.powerW : 0, throttleHead: throttledHead - op.h, scale };
  }

  /** Hydraulic power W: rho g Q H for water with H in Pa-equivalent head (pressure), simply Q * dP. */
  const hydraulicPower = (/** @type {number} */ Q, /** @type {number} */ dP) => Q * dP;

  /** Head in metres of water from pressure Pa. */
  const headMetres = (/** @type {number} */ dP) => dP / (RHO_WATER * G);

  return {
    G, RHO_WATER, RHO_AIR,
    toSI, display, imperial, round, affinity, speedFraction,
    makeCurve, fitSystem, systemHead, intersect, sampleCurve, sampleSystem, compareFixedSpeed, hydraulicPower, headMetres,
  };
});