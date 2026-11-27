'use strict';

class RdfInputDisabledError extends Error {
  constructor() {
    super(
      'RDF input is disabled. The hand-written Turtle reader was removed because it dropped namespaces and triples. Haystack tags are the model path. RDF input returns only with vendored Oxigraph 0.5.13 and the shared 223P role file, keyed by IRI.',
    );
    this.name = 'RdfInputDisabledError';
    this.code = 'rdf_input_disabled';
  }
}

class RoleFilePinError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'RoleFilePinError';
    this.code = code;
  }
}

module.exports = { RdfInputDisabledError, RoleFilePinError };
