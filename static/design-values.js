/**
 * Design values for the Operating point panels, imported from a sim lab bundle (lab_bundle.json: design_values,
 * curves.fans / curves.pumps with design flow, pressure and power plus flow-pressure, flow-power and system curves, all SI)
 * such as an EnergyPlus autosizing run exports. No DOM. Browser global NfftDesignValues; CommonJS for tests.
 *
 * Fallback chain for each design quantity, per pump or fan: nameplate attributes on the NF equipment first, then the
 * bundle, then nothing (the panel draws generic, illustrative curves). Measured points always win for live values.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftDesignValues = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const fin = (/** @type {any} */ v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const localName = (/** @type {any} */ uri) => String(uri || '').split(/[#/]/).pop() || '';
  const norm = (/** @type {any} */ s) => String(s || '').toLowerCase().replace(/^nfft-sim-/, '').replace(/[^a-z0-9]+/g, '');

  /** @param {any[]} rows @param {string} y */
  function series(rows, y) {
    return (Array.isArray(rows) ? rows : [])
      .map((r) => [fin(r && r.flow_m3s), fin(r && r[y])])
      .filter((p) => p[0] !== null && p[1] !== null)
      .sort((a, b) => /** @type {number} */ (a[0]) - /** @type {number} */ (b[0]));
  }

  /** Linear interpolation on [x, y] pairs sorted by x; null outside the range. @param {any[]} pts @param {number} x */
  function interp(pts, x) {
    if (!pts.length || x < pts[0][0] || x > pts[pts.length - 1][0]) return null;
    for (let i = 1; i < pts.length; i += 1) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    return null;
  }

  /** Least-squares quadratic H = c0 + c1 Q + c2 Q^2 (SI). Null with fewer than 3 points. @param {any[]} pts */
  function fitQuadratic(pts) {
    if (pts.length < 3) return null;
    const S = [0, 0, 0, 0, 0];
    const T = [0, 0, 0];
    for (const [q, h] of pts) {
      for (let k = 0; k < 5; k += 1) S[k] += q ** k;
      for (let k = 0; k < 3; k += 1) T[k] += h * q ** k;
    }
    const A = [[S[0], S[1], S[2], T[0]], [S[1], S[2], S[3], T[1]], [S[2], S[3], S[4], T[2]]];
    for (let i = 0; i < 3; i += 1) {
      let p = i;
      for (let r = i + 1; r < 3; r += 1) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]];
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (let r = 0; r < 3; r += 1) {
        if (r === i) continue;
        const f = A[r][i] / A[i][i];
        for (let c = i; c < 4; c += 1) A[r][c] -= f * A[i][c];
      }
    }
    const c = [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
    return c.every(Number.isFinite) ? c : null;
  }

  /**
   * Curve coefficients only for a real fixed-speed curve (pressure falls as flow rises). A rising flow-pressure series is
   * a fan-law sweep over speed, not a fan curve, so it is not used as one.
   * @param {any[]} pts
   */
  function fallingCurve(pts) {
    const c = fitQuadratic(pts);
    if (!c || pts.length < 3) return null;
    return pts[pts.length - 1][1] < pts[0][1] ? c : null;
  }

  /**
   * Parse a lab bundle. Returns null when the shape is not recognised.
   * @param {any} raw
   */
  function parseBundle(raw) {
    if (!raw || typeof raw !== 'object' || !raw.curves || typeof raw.curves !== 'object') return null;
    const status = String((raw.sizing_inventory && raw.sizing_inventory.status) || '').toUpperCase();
    const fromEplus = status !== '' && status !== 'FIXTURE' && status !== 'SAMPLE';
    const label = fromEplus ? 'from EnergyPlus model'
      : status === 'SAMPLE' ? 'from sample design file (not an EnergyPlus run)' : 'from sim lab bundle (fixture, not an EnergyPlus run)';
    const dv = raw.design_values || {};
    const map = raw.nfft_equipment_map && typeof raw.nfft_equipment_map === 'object' ? raw.nfft_equipment_map : {};
    /** @param {any} c @param {'fan'|'pump'} kind */
    const item = (c, kind) => {
      const d = c.design || {};
      const head = series(c.flow_vs_pressure, 'pressure_pa');
      const power = series(c.flow_vs_power, 'power_w');
      let flow = fin(d.design_flow_m3s);
      if (flow === null && kind === 'fan') flow = fin(dv.ahu_supply_fan_design_m3s);
      if (flow === null && kind === 'pump') flow = fin(dv.pump_design_m3s);
      let pressure = fin(d.design_pressure_pa);
      if (pressure === null && flow !== null) pressure = interp(head, flow);
      let pw = fin(d.design_power_w);
      if (pw === null && flow !== null) pw = interp(power, flow);
      const uri = c.rdf_equipment || '';
      return {
        kind, uri, name: c.name || localName(uri), match: map[uri] || map[localName(uri)] || '',
        designFlow: flow, designHead: pressure, designPower: pw, coeffs: fallingCurve(head),
        head, power, system: series(c.system_curve, 'pressure_pa'),
      };
    };
    return {
      label,
      fromEnergyPlus: fromEplus,
      claim: String(raw.claim || ''),
      building: raw.building && raw.building.label ? String(raw.building.label) : '',
      designValues: dv,
      fans: (raw.curves.fans || []).map((/** @type {any} */ c) => item(c, 'fan')),
      pumps: (raw.curves.pumps || []).map((/** @type {any} */ c) => item(c, 'pump')),
    };
  }

  /**
   * The bundle entry for one pump or fan: explicit nfft_equipment_map, then a name match on the RDF local name, then
   * the only entry of that kind when the site has only one of that kind.
   * @param {any} bundle parseBundle() result
   * @param {{ id: string, label?: string, kind: string }} entry
   * @param {number} [sameKind] how many pumps or fans the site has
   */
  function forEquipment(bundle, entry, sameKind) {
    if (!bundle || !entry) return null;
    const list = entry.kind === 'fan' ? bundle.fans : bundle.pumps;
    const key = norm(entry.id);
    const byMap = list.find((/** @type {any} */ x) => x.match && norm(x.match) === key);
    if (byMap) return byMap;
    const byName = list.find((/** @type {any} */ x) => norm(localName(x.uri)) === key || norm(x.name) === key || (entry.label && norm(x.name) === norm(entry.label)));
    if (byName) return byName;
    return list.length === 1 && (sameKind || 0) === 1 ? list[0] : null;
  }

  /**
   * Merge design quantities: nameplate, then bundle. Each field reports its source.
   * @param {any} np NfftOpModel.nameplate() result (SI)
   * @param {any} bundleItem forEquipment() result or null
   * @param {string} [bundleLabel]
   */
  function merge(np, bundleItem, bundleLabel) {
    const label = bundleLabel || 'from sim lab bundle';
    /** @type {Record<string, string>} */
    const sources = {};
    const out = { ...np };
    for (const k of ['designFlow', 'designHead', 'designPower']) {
      if (np[k]) sources[k] = 'nameplate';
      else if (bundleItem && bundleItem[k]) { out[k] = bundleItem[k]; sources[k] = label; } else sources[k] = 'missing';
    }
    if (np.coeffs) sources.coeffs = 'nameplate';
    else if (bundleItem && bundleItem.coeffs) { out.coeffs = bundleItem.coeffs; sources.coeffs = label; } else sources.coeffs = 'missing';
    out.known = !!(out.designFlow && (out.designHead || out.coeffs));
    out.sources = sources;
    return out;
  }

  /** One short line for the panel: where the design numbers came from. @param {any} np merged */
  function sourceLine(np) {
    const s = np.sources || {};
    const parts = [['design flow', s.designFlow], ['design pressure', s.designHead], ['design power', s.designPower], ['curve', s.coeffs]];
    return parts.map(([k, v]) => `${k}: ${v === 'missing' || !v ? 'missing (generic)' : v}`).join(' · ');
  }

  return { parseBundle, forEquipment, merge, sourceLine, fitQuadratic, interp, series };
});
