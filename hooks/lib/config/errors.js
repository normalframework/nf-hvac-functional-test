'use strict';

/**
 * @typedef {object} ConfigIssue
 * @property {string} code
 * @property {string} path
 * @property {string} message
 */

class ConfigError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [issuePath]
   */
  constructor(code, message, issuePath) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.issuePath = issuePath || '';
  }
}

module.exports = { ConfigError };
