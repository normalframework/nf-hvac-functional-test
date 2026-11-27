'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LCOV = path.join(ROOT, 'coverage', 'lcov.info');
const LINE_FLOOR = 90;

const ALWAYS = [
  'lib/roles.js',
  'lib/units.js',
  'lib/config/allowlist.js',
  'lib/config/defaults.js',
  'lib/config/errors.js',
  'lib/config/gates.js',
  'lib/config/index.js',
  'lib/config/priority.js',
  'lib/config/schema.js',
  'lib/config/semantic.js',
  'lib/model/errors.js',
  'lib/model/map.js',
  'lib/model/haystack.js',
  'lib/model/rdf.js',
  'lib/model/role_iri.js',
  'lib/model/role_pin.js',
  'lib/model/writable.js',
  'lib/model/vocabulary.js',
  'lib/roles_sync.js',
  'lib/runtime.js',
  'lib/model/index.js',
  'lib/plan.js',
  'lib/nf/client.js',
  'lib/nf/duration.js',
  'lib/run_seq.js',
  'lib/ulid.js',
  'lib/manifest.js',
  'lib/trigger_store.js',
  'lib/trigger_run.js',
  'static/js/core/rrule.js',
  'static/js/core/timetable.js',
  'static/js/core/trigger.js',
  'static/js/core/stateview.js',
  'static/js/core/touchmap.js',
];

const WHEN_PRESENT = [
  'lib/machine.js',
  'lib/ledger.js',
  'lib/runner.js',
  'lib/interlocks.js',
  'lib/writers/nf_command.js',
  'lib/writers/bacnet_direct.js',
  'lib/writers/dry_run.js',
  'lib/writers/verify.js',
  'lib/writers/release.js',
];

/**
 * @param {string} text
 * @returns {Map<string, { hit: number, found: number }>}
 */
function parseLcov(text) {
  /** @type {Map<string, { hit: number, found: number }>} */
  const files = new Map();
  for (const record of text.split('end_of_record')) {
    const lines = record.split('\n');
    let file = '';
    let hit = 0;
    let found = 0;
    let saw = false;
    for (const line of lines) {
      if (line.startsWith('SF:')) {
        file = line.slice(3).trim();
        saw = true;
      } else if (line.startsWith('LH:')) hit = Number(line.slice(3));
      else if (line.startsWith('LF:')) found = Number(line.slice(3));
    }
    if (saw && file) files.set(normalize(file), { hit, found });
  }
  return files;
}

/**
 * @param {string} file
 */
function normalize(file) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function testFiles() {
  return fs.readdirSync(path.join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => `test/${name}`);
}

function main() {
  fs.mkdirSync(path.dirname(LCOV), { recursive: true });
  const args = [
    '--test',
    '--experimental-test-coverage',
    '--test-reporter=spec',
    '--test-reporter=lcov',
    '--test-reporter-destination=stdout',
    '--test-reporter-destination=coverage/lcov.info',
    ...testFiles(),
  ];
  const child = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (child.status !== 0) process.exit(child.status || 1);
  const report = parseLcov(fs.readFileSync(LCOV, 'utf8'));
  const required = ALWAYS.slice();
  for (const rel of WHEN_PRESENT) {
    if (fs.existsSync(path.join(ROOT, rel))) required.push(rel);
  }
  let failed = false;
  for (const rel of required) {
    const row = report.get(rel);
    if (!row || row.found === 0) {
      console.error(`coverage: ${rel} has no line data`);
      failed = true;
      continue;
    }
    const pct = (100 * row.hit) / row.found;
    const rounded = Math.floor(pct * 10) / 10;
    if (pct < LINE_FLOOR) {
      console.error(`coverage: ${rel} line coverage ${rounded}% is below ${LINE_FLOOR}%`);
      failed = true;
    } else {
      console.log(`coverage: ${rel} lines ${rounded}%`);
    }
  }
  if (failed) process.exit(1);
}

main();
