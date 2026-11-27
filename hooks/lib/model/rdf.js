'use strict';

const { RdfInputDisabledError } = require('./errors');

/**
 * RDF input is refused. The previous splitter is not called.
 * @param {string} [_text]
 * @param {any} [_map]
 */
function loadRdfModel(_text, _map) {
  throw new RdfInputDisabledError();
}

/**
 * @param {string} [_text]
 */
function parseTtl(_text) {
  throw new RdfInputDisabledError();
}

module.exports = { loadRdfModel, parseTtl, RdfInputDisabledError };
