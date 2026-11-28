/**
 * Which installed NF app should supply the 223P graph (its read-only rdf hook).
 * Prefer Open-FDD, then Open-FDD Lite, then any other app that exposes an rdf hook.
 * Browser global NfftRdfSource; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftRdfSource = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFERRED = ['open-fdd', 'open-fdd-lite'];

  /**
   * @param {any} app
   */
  function hasRdf(app) {
    return Array.isArray(app && app.hooks) && app.hooks.some((h) => (h && (h.id || h.name)) === 'rdf');
  }

  /**
   * @param {any[]} applications GET /api/v1/apps applications list
   * @param {string} [selfId] this app's id, never selected
   * @returns {string[]}
   */
  function rdfAppIds(applications, selfId) {
    const apps = Array.isArray(applications) ? applications : [];
    /** @type {string[]} */
    const ids = [];
    for (const id of PREFERRED) {
      const app = apps.find((a) => a && a.id === id);
      if (app && hasRdf(app) && app.id !== selfId) ids.push(app.id);
    }
    for (const app of apps) {
      if (app && app.id && app.id !== selfId && hasRdf(app) && ids.indexOf(app.id) === -1) ids.push(app.id);
    }
    if (!ids.length) return PREFERRED.filter((id) => id !== selfId);
    return ids;
  }

  return { PREFERRED, hasRdf, rdfAppIds };
});
