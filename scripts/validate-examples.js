'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateSiteConfig } = require('../hooks/lib/config');

const dir = path.join(__dirname, '..', 'examples');
const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
if (files.length === 0) {
  console.error('no example configs');
  process.exit(1);
}

let failed = false;
for (const name of files) {
  const full = path.join(dir, name);
  const input = JSON.parse(fs.readFileSync(full, 'utf8'));
  const result = validateSiteConfig(input);
  if (!result.ok) {
    failed = true;
    console.error(`${name} failed validation`);
    for (const error of result.errors) console.error(`  ${error.code} ${error.path}: ${error.message}`);
  } else if (result.config.dry_run !== true) {
    failed = true;
    console.error(`${name} must keep dry_run true`);
  } else {
    console.log(`${name} ok`);
  }
}
if (failed) process.exit(1);
