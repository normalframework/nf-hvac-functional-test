'use strict';

/**
 * Bind type IRIs to one snake_case role. The key is the full IRI.
 * A shared local name does not match. Zero hits or several different
 * roles return null so the caller does not guess.
 * @param {readonly string[]} typeIris
 * @param {ReadonlyMap<string, string>} rolesByIri
 * @returns {string | null}
 */
function matchRoleIri(typeIris, rolesByIri) {
  /** @type {string[]} */
  const hits = [];
  for (const iri of typeIris) {
    if (typeof iri !== 'string' || iri.length === 0) continue;
    if (!rolesByIri.has(iri)) continue;
    const role = rolesByIri.get(iri);
    if (typeof role !== 'string' || role.length === 0) continue;
    if (!hits.includes(role)) hits.push(role);
  }
  if (hits.length !== 1) return null;
  return hits[0];
}

module.exports = { matchRoleIri };
