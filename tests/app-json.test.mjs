import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));

/** NF 3.10 derives an app id from the name: lower case, runs of non-alphanumerics become "-". Same as nf_app_sync.py. */
const slug = (/** @type {string} */ name) => (name.toLowerCase().match(/[a-z0-9]+/g) || []).join('-');

test('app.json name derives the app id, so a normal deploy installs as nf-hvac-functional-test', () => {
  assert.equal(app.id, 'nf-hvac-functional-test');
  assert.equal(slug(app.name), app.id, 'NF ignores the id on create and uses the slug of the name');
});

test('the page and docs use the same app id as app.json', () => {
  const index = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
  assert.doesNotMatch(index, /apps\/(?!static)[a-z0-9-]*hvac/);
  const install = fs.readFileSync(path.join(ROOT, 'docs', 'INSTALL.md'), 'utf8');
  assert.match(install, new RegExp(`/api/v1/apps/static/${app.id}/`));
});

test('every hook definition has a matching entry point file', () => {
  const dir = path.join(ROOT, 'hooks-update');
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(names.length >= 4);
  for (const f of names) {
    const { hook } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(fs.existsSync(path.join(ROOT, hook.entryPoint)), `${f}: ${hook.entryPoint} exists`);
    assert.equal(`${hook.name}.json`, f);
  }
});