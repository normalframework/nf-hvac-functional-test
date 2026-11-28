'use strict';
/**
 * Match simulator points to the Open-FDD role catalog (vendor/roles/openfdd-roles.json, pinned to an Open-FDD
 * release) the same way Open-FDD binds them: every role marker present, no forbidden marker, equipment markers
 * present. The most specific match wins; on a tie a 223P-grounded role beats an extension and an equipment-scoped
 * role beats a generic one. Points with no match, or only the catch-all extension roles, are reported as gaps.
 */
const CATALOG = require('../../vendor/roles/openfdd-roles.json');

const QTY = ['temp', 'pressure', 'flow', 'humidity', 'speed', 'power'];
const CATCH_ALL = new Set(['test_operating_mode_command', 'operating_status']);

/** @param {string | string[] | undefined} m */
const list = (m) => (Array.isArray(m) ? m : String(m || '').split(',')).map((x) => x.trim()).filter(Boolean);

/** Scope words from a role id, used to break ties by equipment kind. */
const SCOPE = /** @type {Record<string, string[]>} */ ({
  ahu: ['air_handling_unit_'],
  vav: ['terminal_unit_'],
});

/**
 * @param {string | string[]} pointMarkers
 * @param {string | string[]} equipMarkers
 * @param {any} [catalog]
 * @returns {{ role: string | null, grounding: string | null, candidates: string[], gap: string | null }}
 */
function matchRole(pointMarkers, equipMarkers, catalog) {
  const roles = (catalog || CATALOG).roles || [];
  const pm = new Set(list(pointMarkers));
  const em = new Set(list(equipMarkers));
  const kind = em.has('ahu') ? 'ahu' : em.has('vav') || em.has('airTerminalUnit') ? 'vav' : 'other';
  const hits = roles.filter((/** @type {any} */ r) => {
    const h = r.haystack;
    if (!h || !Array.isArray(h.markers) || !h.markers.length) return false;
    if (!h.markers.every((/** @type {string} */ m) => pm.has(m))) return false;
    if ((h.forbid || []).some((/** @type {string} */ m) => pm.has(m))) return false;
    return (h.equip_markers || []).every((/** @type {string} */ m) => em.has(m));
  });
  const score = (/** @type {any} */ r) => {
    const own = (SCOPE[kind] || []).some((p) => r.role.startsWith(p)) ? 1 : 0;
    const other = Object.entries(SCOPE).some(([k, ps]) => k !== kind && ps.some((p) => r.role.startsWith(p))) ? -1 : 0;
    return r.haystack.markers.length * 10 + (r.grounding === 's223' ? 2 : 0) + own * 3 + other * 3 - (CATCH_ALL.has(r.role) ? 50 : 0);
  };
  hits.sort((a, b) => score(b) - score(a) || a.role.localeCompare(b.role));
  const best = hits[0] || null;
  const candidates = hits.map((/** @type {any} */ r) => r.role);
  if (!best) return { role: null, grounding: null, candidates, gap: 'no Open-FDD role matches these Haystack tags' };
  const qty = QTY.find((q) => pm.has(q));
  if (qty && !best.haystack.markers.includes(qty)) {
    return { role: best.role, grounding: best.grounding, candidates, gap: `binds as ${best.role}, which is not a ${qty} role: the catalog has no matching ${qty} role yet` };
  }
  if (CATCH_ALL.has(best.role)) return { role: null, grounding: null, candidates, gap: `only the catch-all ${best.role} matches` };
  return { role: best.role, grounding: best.grounding, candidates, gap: best.grounding === 's223' ? null : '223P has no class for this yet; Haystack-tag role (Open-FDD extension)' };
}

/**
 * Conformance of a simulator catalog against the Open-FDD roles.
 * @param {{ equipment: any[], points: any[] }} cat
 * @param {any} [catalog]
 */
function conformance(cat, catalog) {
  return conformanceOf(cat, catalog);
}

/** @param {{ equipment: any[], points: any[] }} cat @param {any} [catalog] */
function conformanceOf(cat, catalog) {
  const eq = new Map(cat.equipment.map((e) => [e.id, e.markers]));
  const rows = cat.points.map((p) => {
    const m = matchRole(p.markers, eq.get(p.equipRef) || '', catalog);
    return { id: p.sourceId || p.id, equipRef: p.equipRef, markers: p.markers, simOnly: !!p.simOnly, ...m };
  });
  const s223 = rows.filter((r) => r.grounding === 's223').length;
  const ext = rows.filter((r) => r.role && r.grounding !== 's223').length;
  return {
    release: (catalog || CATALOG).openfdd_release,
    catalog_version: (catalog || CATALOG).version,
    points: rows.length, s223, extension: ext, unmatched: rows.length - s223 - ext,
    rows,
  };
}

module.exports = { matchRole, conformance, CATALOG };
