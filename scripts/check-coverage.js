'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LCOV = path.join(ROOT, 'coverage', 'lcov.info');
const LINE_FLOOR = 90;

const ALWAYS = [
  'hooks/lib/roles.js',
  'hooks/lib/units.js',
  'hooks/lib/config/allowlist.js',
  'hooks/lib/config/defaults.js',
  'hooks/lib/config/errors.js',
  'hooks/lib/config/gates.js',
  'hooks/lib/config/index.js',
  'hooks/lib/config/priority.js',
  'hooks/lib/config/schema.js',
  'hooks/lib/config/semantic.js',
  'hooks/lib/model/errors.js',
  'hooks/lib/model/map.js',
  'hooks/lib/model/haystack.js',
  'hooks/lib/model/rdf.js',
  'hooks/lib/model/role_iri.js',
  'hooks/lib/model/role_pin.js',
  'hooks/lib/model/writable.js',
  'hooks/lib/model/vocabulary.js',
  'hooks/lib/roles_sync.js',
  'hooks/lib/runtime.js',
  'hooks/lib/sim.js',
  'hooks/lib/model/index.js',
  'hooks/lib/plan.js',
  'hooks/lib/nf/client.js',
  'hooks/lib/nf/duration.js',
  'hooks/lib/run_seq.js',
  'hooks/lib/ulid.js',
  'hooks/lib/manifest.js',
  'hooks/lib/trigger_store.js',
  'hooks/lib/trigger_run.js',
  'static/rrule.js',
  'static/timetable.js',
  'static/trigger.js',
  'static/stateview.js',
  'static/touchmap.js',
  'static/s223.js',
  'static/haystack-bind.js',
  'static/tags-223p.js',
  'static/model-source.js',
  'static/systems.js',
  'static/ftest-strategies.js',
  'static/ftest.js',
  'static/deficiencies.js',
  'static/graphic.js',
];

const WHEN_PRESENT = [
  'hooks/lib/machine.js',
  'hooks/lib/ledger.js',
  'hooks/lib/runner.js',
  'hooks/lib/interlocks.js',
  'hooks/lib/writers/nf_command.js',
  'hooks/lib/writers/bacnet_direct.js',
  'hooks/lib/writers/dry_run.js',
  'hooks/lib/writers/verify.js',
  'hooks/lib/writers/release.js',
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
  return fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => `tests/${name}`);
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
