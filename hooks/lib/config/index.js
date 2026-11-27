'use strict';

const { applyDefaults } = require('./defaults');
const { schemaIssues } = require('./schema');
const { semanticIssues } = require('./semantic');
const { checkPriority } = require('./priority');
const { ConfigError } = require('./errors');

/**
 * @param {unknown} input
 * @returns {{ ok: true, config: any, errors: [] } | { ok: false, errors: { code: string, path: string, message: string }[] }}
 */
function validateSiteConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ code: 'type', path: '', message: 'Config must be a JSON object' }],
    };
  }
  /** @type {{ code: string, path: string, message: string }[]} */
  const errors = [];
  const raw = /** @type {Record<string, any>} */ (input);
  if (raw.write && Object.prototype.hasOwnProperty.call(raw.write, 'bacnet_priority')) {
    const priority = checkPriority(raw.write.bacnet_priority);
    if (!priority.ok) errors.push({ code: priority.code, path: 'write.bacnet_priority', message: priority.message });
  }
  errors.push(...schemaIssues(raw));
  if (errors.length > 0) return { ok: false, errors };
  const config = applyDefaults(raw);
  const semantic = semanticIssues(config);
  if (semantic.length > 0) return { ok: false, errors: semantic };
  return { ok: true, config, errors: [] };
}

/**
 * @param {unknown} input
 */
function loadSiteConfig(input) {
  const result = validateSiteConfig(input);
  if (!result.ok) {
    const first = result.errors[0];
    throw new ConfigError(first.code, first.message, first.path);
  }
  return result.config;
}

module.exports = {
  validateSiteConfig,
  loadSiteConfig,
  applyDefaults,
};
