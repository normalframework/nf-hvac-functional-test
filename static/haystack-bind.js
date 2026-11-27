/**
 * Haystack tags to Open-FDD roles, following the normative haystack.binding_rules of the vendored roles file
 * (vendor/roles/openfdd-roles.json, generated into static/roles-223p.js). Tag sets, forbids, equipment
 * constraints and classes all come from that file; nothing here names a role.
 *
 * Browser global NfftHaystackBind; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftHaystackBind = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Accepted function marker of a role: its own, else the one its 223P class implies. */
  function functionMarker(/** @type {any} */ role, /** @type {string[]} */ fns) {
    const own = role.haystack.markers.filter((/** @type {string} */ m) => fns.includes(m));
    if (own.length) return own[0];
    const cls = (role.s223 && role.s223.property_class) || '';
    if (/Observable/.test(cls)) return 'sensor';
    const aspects = (role.s223 && role.s223.aspects) || [];
    if (aspects.some((/** @type {string} */ a) => /Setpoint|Maximum|Minimum|Limit/.test(a))) return 'sp';
    return 'cmd';
  }

  /**
   * Does one role accept the point?
   * @param {any} role
   * @param {{ markers: string[], cls?: string }} point
   * @param {string[]} parent markers of the point's equipment
   * @param {string[]} fns function markers
   */
  function accepts(role, point, parent, fns) {
    const h = role.haystack;
    if (!h) return false;
    const tags = new Set(point.markers);
    const parentSet = new Set(parent);
    const fn = functionMarker(role, fns);
    if (fns.some((m) => m !== fn && tags.has(m))) return false;
    if (h.forbid.some((/** @type {string} */ m) => tags.has(m))) return false;
    if (h.equip_markers.some((/** @type {string} */ m) => !parentSet.has(m))) return false;
    if (h.equip_forbid.some((/** @type {string} */ m) => parentSet.has(m))) return false;
    const classes = String(point.cls || '').split(',').map((c) => c.trim()).filter(Boolean);
    if (classes.some((c) => h.classes.includes(c))) return true;
    const sets = [h.markers, ...h.alt_markers];
    return sets.some((/** @type {string[]} */ set) => set.length > 0 && set.every((m) => tags.has(m)))
      && h.custom_markers.every((/** @type {string} */ m) => tags.has(m));
  }

  const isStrictSuperset = (/** @type {string[]} */ a, /** @type {string[]} */ b) => a.length > b.length && b.every((m) => a.includes(m));

  /**
   * Bind one point. Several candidates: the one whose markers are a strict superset of every other wins;
   * otherwise the point stays unbound and the candidates are reported. List order never decides.
   * @param {{ markers: string[], cls?: string }} point
   * @param {string[]} parent
   * @param {{ roles: any[], function_markers?: string[] }} vocab
   * @param {string} [scope] binding_scope being resolved: 'own' (default) binds an equipment's own points
   */
  function bindPoint(point, parent, vocab, scope = 'own') {
    const fns = vocab.function_markers || ['sensor', 'sp', 'cmd'];
    const hits = vocab.roles.filter((r) => r.haystack && (r.haystack.binding_scope || 'own') === scope && accepts(r, point, parent, fns));
    if (hits.length <= 1) return { role: hits[0] ? hits[0].role : null, candidates: hits.map((r) => r.role) };
    const winner = hits.filter((r) => hits.every((o) => o === r || isStrictSuperset(r.haystack.markers, o.haystack.markers)));
    return { role: winner.length === 1 ? winner[0].role : null, candidates: hits.map((r) => r.role) };
  }

  /**
   * Bind every point of one equipment. When several points bind the same role, the one with the most optional
   * markers wins; a remaining tie leaves the role unbound and reported.
   * @param {{ id: string, markers: string[], cls?: string }[]} points
   * @param {string[]} parent
   * @param {any} vocab
   */
  function bindEquipment(points, parent, vocab) {
    /** @type {Map<string, any[]>} */
    const byRole = new Map();
    const unbound = [];
    const ambiguous = [];
    for (const p of points) {
      const r = bindPoint(p, parent, vocab);
      if (!r.role) {
        if (r.candidates.length > 1) ambiguous.push({ point: p.id, candidates: r.candidates });
        else unbound.push(p.id);
        continue;
      }
      if (!byRole.has(r.role)) byRole.set(r.role, []);
      /** @type {any[]} */ (byRole.get(r.role)).push(p);
    }
    /** @type {Record<string, string>} point id -> role */
    const bound = {};
    const duplicates = [];
    for (const [role, list] of byRole) {
      const def = vocab.roles.find((/** @type {any} */ x) => x.role === role);
      const score = (/** @type {any} */ p) => def.haystack.optional.filter((/** @type {string} */ m) => p.markers.includes(m)).length;
      const best = Math.max(...list.map(score));
      const top = list.filter((p) => score(p) === best);
      if (top.length === 1) bound[top[0].id] = role;
      else duplicates.push({ role, points: top.map((p) => p.id) });
    }
    return { bound, unbound, ambiguous, duplicates };
  }

  return { bindPoint, bindEquipment, accepts, functionMarker };
});
