'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createManifest(runId, extra = {}) {
  return {
    run_id: runId,
    run_seq: extra.run_seq || 0,
    plugin_version: extra.plugin_version || '0.1.0',
    started_at: '',
    ended_at: '',
    dry_run: false,
    steps: /** @type {any[]} */ ([]),
    samples: /** @type {any[]} */ ([]),
    overrides: /** @type {any[]} */ ([]),
    release: { all_verified: false, retries: 0 },
    reason: '',
  };
}

/**
 * @param {any} manifest
 * @param {{ step_id: string, index: number, started_at: string }} step
 */
function openStep(manifest, step) {
  const previous = manifest.steps[manifest.steps.length - 1];
  if (previous && !previous.ended_at) previous.ended_at = step.started_at;
  manifest.steps.push({
    step_id: step.step_id,
    index: step.index,
    started_at: step.started_at,
    ended_at: '',
    skipped: false,
  });
}

/**
 * @param {any} manifest
 * @param {string} endedAt
 * @param {string} dir
 */
function finishManifest(manifest, endedAt, dir) {
  manifest.ended_at = endedAt;
  const previous = manifest.steps[manifest.steps.length - 1];
  if (previous && !previous.ended_at) previous.ended_at = endedAt;
  return writeManifest(manifest, dir);
}

/**
 * @param {any} manifest
 * @param {string} dir
 */
function writeManifest(manifest, dir) {
  if (!dir) return manifest;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${manifest.run_id}.json`);
  const tmp = `${dest}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { createManifest, openStep, finishManifest, writeManifest };
