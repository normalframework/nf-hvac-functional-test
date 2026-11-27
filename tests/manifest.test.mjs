import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { allocateRunSeq } = require('../hooks/lib/run_seq');
const { createManifest, writeManifest } = require('../hooks/lib/manifest');

test('run numbers increase and the manifest is on disk before the run ends', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-'));
  const local = path.join(root, 'local');
  const runs = path.join(local, 'runs');
  assert.equal(allocateRunSeq(local), 1);
  assert.equal(allocateRunSeq(local), 2);
  fs.writeFileSync(path.join(local, 'run_seq'), 'not-a-number');
  assert.equal(allocateRunSeq(local), 1);
  const manifest = createManifest('run_manifest', { run_seq: 2 });
  manifest.started_at = '2026-01-01T00:00:00.000Z';
  const dest = writeManifest(manifest, runs);
  const saved = JSON.parse(fs.readFileSync(String(dest), 'utf8'));
  assert.equal(saved.run_seq, 2);
  assert.equal(saved.plugin_version, '0.1.0');
  assert.equal(saved.ended_at, '');
});
