'use strict';
/**
 * Sim-to-live cutover. A run on the Simulation target that passed every check can be signed off; the Live NF site
 * target can only start a live (writing) run when a sign-off exists for the same plan fingerprint (plan, limits,
 * interlocks, write policy, VAV test settings and per-equipment role coverage; uuids and ids left out). Dry-run on
 * live stays allowed without a sign-off. Nothing here writes to NF.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Evidence = require('../../static/evidence.js');

const FILE = 'signoffs.json';
const TARGETS = ['simulation', 'live'];

/** @param {any} config */
function planHash(config) {
  return crypto.createHash('sha256').update(Evidence.planFingerprint(config)).digest('hex');
}

/** @param {any} v */
function unwrap(v) {
  if (v && typeof v === 'object') {
    for (const k of ['string', 'boolean', 'number']) if (k in v) return v[k];
  }
  return v;
}

/** Selected test target, or null when the option is not set (older installs keep their behaviour). @param {any} options */
function targetOf(options) {
  const raw = String(unwrap((options || {}).testTarget) || '').trim().toLowerCase();
  return TARGETS.includes(raw) ? raw : null;
}

/** @param {string} root */
function load(root) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(root, FILE), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Store a sign-off for a passed simulation evidence report whose plan hash matches the config it ran.
 * @param {string} root @param {any} report evidence report @param {any} config the simulation config in force
 */
function signOff(root, report, config) {
  if (!report || report.schema !== Evidence.SCHEMA) return { ok: false, code: 'not_evidence' };
  if (report.target !== 'simulation') return { ok: false, code: 'not_simulation' };
  if (report.verdict !== 'pass') return { ok: false, code: 'not_passed' };
  const hash = planHash(config);
  if (report.plan_hash !== hash) return { ok: false, code: 'plan_changed', expected: hash };
  const entry = { plan_hash: hash, run_ids: report.run_ids || [], verdict: 'pass', signed_at: new Date().toISOString(), sequences: (report.sequences || []).map((/** @type {any} */ s) => ({ test_id: s.test_id, verdict: s.verdict })) };
  const list = load(root).filter((s) => s.plan_hash !== hash || (s.run_ids || []).join() !== entry.run_ids.join());
  list.push(entry);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, FILE), `${JSON.stringify(list.slice(-20), null, 1)}\n`);
  return { ok: true, signoff: entry };
}

/**
 * May a run start? Live target + live writes need a matching sign-off. Simulation target always may.
 * @param {string} root @param {any} options @param {any} config @param {{ live?: boolean }} args
 */
function gate(root, options, config, args) {
  const target = targetOf(options);
  if (target !== 'live' || !(args && args.live === true) || (config && config.dry_run !== false)) return { ok: true, target };
  const hash = planHash(config);
  const g = Evidence.liveGate(load(root), hash);
  return g.ok ? { ok: true, target, signoff: g.signoff } : { ...g, target, plan_hash: hash };
}

module.exports = { planHash, targetOf, load, signOff, gate, FILE, TARGETS };
