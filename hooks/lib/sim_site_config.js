'use strict';
/**
 * Site config for the office simulator, built from objects this app created (names nfft-sim.*) and nothing
 * else. Roles come from nfft's own Haystack role map, the same path a real site's tags take. Written by the sim
 * hook to the app state folder and used only when no siteConfig option is set and the simulator is armed, so a
 * real site always needs its own reviewed config.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadHaystackModel } = require('./model');
const { getRole, roleAllowsWrite } = require('./roles');

const FILE = 'sim-site-config.json';
const LAYER = 'hpl:bacnet:1';

/** Site-config ids are snake case: nfft-sim-vav-1-01 -> vav_1_01. @param {string} id */
const configId = (id) => id.replace(/^nfft-sim-/, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();

/** @param {any} o */
function nameOf(o) {
  const p = (o.props || []).find((/** @type {any} */ x) => x.property === 'PROP_OBJECT_NAME');
  return (p && p.value && p.value.characterString) || '';
}

/** @param {string} markers */
function kindOf(markers) {
  const m = markers.split(',');
  if (m.includes('ahu')) return 'ahu';
  if (m.includes('vav')) return 'vav';
  return null;
}

/**
 * @param {{ equipment: any[], points: any[] }} cat office catalog (sim.catalog(undefined, { layout: 'office' }))
 * @param {any} listing GET /api/v1/bacnet/local
 * @param {{ priority?: number | null }} [opts] priority: NF's command priority (BACNET_PRIORITY), so the run's
 *   priority check passes on this NF; the check itself is unchanged
 * @returns {{ config: any, bound: number, missing: string[] } | null} null until every catalog object exists
 */
function build(cat, listing, opts) {
  /** @type {Map<string, string>} */
  const uuidOf = new Map();
  for (const o of (listing && listing.objects) || []) {
    const n = nameOf(o);
    if (n.startsWith('nfft-sim.') && typeof o.uuid === 'string') uuidOf.set(n, o.uuid);
  }
  const missing = cat.points.filter((p) => !uuidOf.has(p.name)).map((p) => p.name);
  if (missing.length) return null;
  const types = new Map(cat.equipment.map((e) => [e.id, kindOf(e.markers)]));
  const equipment = cat.equipment.filter((e) => types.get(e.id)).map((e) => ({
    id: e.id, type: types.get(e.id), tags: e.markers.split(','), ahuRef: e.airRef || undefined,
  }));
  const points = cat.points.filter((p) => types.get(p.equipRef)).map((p) => ({
    uuid: uuidOf.get(p.name), layer: LAYER, equipRef: p.equipRef, unit: p.unit || null, tags: p.markers.split(','),
    attrs: { equipRef: p.equipRef },
  }));
  const model = loadHaystackModel({ equipment, points });
  let bound = 0;
  const items = model.equipment.filter((e) => e.type === 'ahu' || e.type === 'vav').map((e) => {
    /** @type {Record<string, any>} */
    const pts = {};
    for (const [role, b] of Object.entries(e.points)) {
      const typed = /** @type {any} */ (b);
      const r = getRole(role);
      pts[role] = typed.writable && r && roleAllowsWrite(r) ? { uuid: typed.uuid, layer: LAYER, writable: true } : { uuid: typed.uuid, layer: LAYER };
      bound += 1;
    }
    /** @type {any} */
    const item = { id: configId(e.id), type: e.type, points: pts };
    if (e.type === 'ahu') item.serves = model.equipment.filter((v) => v.type === 'vav' && v.ahuRef === e.id).map((v) => configId(v.id));
    return item;
  });
  items.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id, undefined, { numeric: true }) : a.type === 'ahu' ? -1 : 1));
  const vavs = items.filter((i) => i.type === 'vav').length;
  const config = {
    version: 1,
    dry_run: false,
    write: { backend: 'nf_command', bacnet_priority: opts && Number.isInteger(opts.priority) ? opts.priority : 12, command_lease_s: 300, keepalive_s: 60, verify_s: 30, release_retries: 6, release_backoff_s: [5, 10, 20, 40, 60, 120] },
    limits: { max_total_minutes: 150, max_tick_gap_s: 90, max_comm_failures: 3, max_boxes_overridden: Math.max(1, vavs), max_sample_age_s: 180 },
    interlocks: {
      duct_static_pressure_max_pa: 1000, mixed_air_temperature_min_c: 7, discharge_air_temperature_min_c: 5,
      zone_air_temperature_min_c: 16, zone_air_temperature_max_c: 29, fan_status_loss_abort: true,
      freeze_protection_status_abort: true, smoke_alarm_status_abort: true,
    },
    logging: { mode: 'shadow', sample_interval_s: 20, boost_period_s: 30, max_boosted_points: 60, recovery_minutes: 2 },
    plan: {
      steps: [
        { step_id: 'ahu.baseline', hold_minutes: 2 },
        { step_id: 'ahu.recirc', hold_minutes: 3, settle_minutes: 1 },
        { step_id: 'ahu.economizer', hold_minutes: 3, settle_minutes: 1, conditional: 'econ_window' },
        { step_id: 'vav.max_cool', enabled: true, hold_minutes: 5, settle_minutes: 1 },
        { step_id: 'recovery', hold_minutes: 2 },
      ],
      econ_window: { low_c: 10, high_c: 18, min_delta_k: 3, max_rh_pct: 70 },
      ahu_strategy: 'per_point',
    },
    vav_test: { strategy: 'auto_per_box', per_box_strategy: ['airflow_setpoint', 'flush_point'], ahu_mode: 'auto', batch_size: 10, batch_delay_s: 5, min_capable_boxes: 1, airflow_setpoint_default_m3s: null },
    equipment: items,
  };
  return { config, bound, missing };
}

/** @param {string} root */
function filePath(root) {
  return path.join(root, FILE);
}

/** @param {string} root @param {any} config */
function save(root, config) {
  fs.mkdirSync(root, { recursive: true });
  const target = filePath(root);
  const text = `${JSON.stringify(config, null, 1)}\n`;
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === text) return false;
  fs.writeFileSync(`${target}.tmp`, text);
  fs.renameSync(`${target}.tmp`, target);
  return true;
}

/** @param {string} root */
function load(root) {
  try {
    return JSON.parse(fs.readFileSync(filePath(root), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { configId, build, save, load, filePath, FILE, LAYER };
