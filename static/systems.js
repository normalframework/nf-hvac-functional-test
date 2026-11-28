/**
 * Group discovered 223P equipment into air-handling systems.
 * VAVs attach to an AHU only through model feed relationships (already walked by
 * NfftS223.discover / NfftTags223p.derive). A terminal with no feed is unassigned
 * and not testable until it is mapped. Browser global NfftSystems; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftSystems = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {any} model NfftS223.discover() / buildModel() result
   * @returns {{ systems: any[], unassigned: any[], warnings: string[] }}
   */
  function fromModel(model) {
    const ahus = (model && model.ahus) || [];
    const assigned = new Set();
    const systems = ahus.map((/** @type {any} */ ahu) => {
      const terminals = ahu.terminals || [];
      for (const t of terminals) assigned.add(t.iri || t.id);
      return {
        id: ahu.id,
        iri: ahu.iri,
        label: ahu.label || ahu.id,
        unit: ahu,
        terminals,
        kind: 'air_handling_system',
        unassigned: false,
      };
    });
    /** @type {any[]} */
    const loose = Array.isArray(model && model.unassigned) ? model.unassigned.slice() : [];
    const extra = (model && model.other) || [];
    for (const n of extra) {
      if (/terminal/i.test(n.kind || '') && !assigned.has(n.iri || n.id) && !loose.some((t) => (t.iri || t.id) === (n.iri || n.id))) {
        loose.push(n);
      }
    }
    const unassigned = loose.filter((t) => !assigned.has(t.iri || t.id)).map((t) => ({
      id: t.id,
      iri: t.iri,
      label: t.label || t.id,
      unit: t,
      terminals: [],
      kind: 'unassigned_terminal',
      unassigned: true,
      reason: 'no_feed_relationship',
    }));
    const warnings = [...((model && model.warnings) || [])];
    if (unassigned.length) {
      warnings.push(`${unassigned.length} terminal${unassigned.length === 1 ? '' : 's'} not fed by an air handler (not testable until mapped)`);
    }
    return { systems, unassigned, warnings };
  }

  /**
   * @param {{ systems: any[], unassigned: any[] }} groups
   * @param {string} id
   */
  function find(groups, id) {
    if (id === 'unassigned') return { id: 'unassigned', label: 'Unassigned terminals', terminals: groups.unassigned, unassigned: true, kind: 'unassigned_group', unit: null };
    return groups.systems.find((s) => s.id === id) || groups.systems[0] || null;
  }

  return { fromModel, find };
});
