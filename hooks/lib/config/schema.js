'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Ajv2020 } = require('ajv/dist/2020');

const schemaPath = path.join(__dirname, '..', '..', '..', 'schema', 'site-config.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateSchema: true,
  allowUnionTypes: true,
});

const validate = ajv.compile(schema);

/**
 * @param {unknown} input
 * @returns {{ code: string, path: string, message: string }[]}
 */
function schemaIssues(input) {
  const ok = validate(input);
  if (ok) return [];
  /** @type {import('ajv').ErrorObject[]} */
  const errors = validate.errors || [];
  return errors.map((error) => ({
    code: 'schema',
    path: error.instancePath ? error.instancePath.slice(1).replaceAll('/', '.') : '',
    message: `${error.instancePath || '/'} ${error.message || 'invalid'}`,
  }));
}

module.exports = { schemaIssues, schemaPath };
