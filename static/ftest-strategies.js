/**
 * Pluggable per-VAV override strategies. A site chooses a strategy from the bound
 * model (writable roles) or an explicit per-box `vav_override` in the site config.
 * Built-in strategies: write_airflow_setpoint, toggle_boolean, set_multistate, unsupported.
 * Legacy plan names airflow_setpoint, flush_point and bas_toggle are aliases.
 * Browser global NfftFtestStrategies; CommonJS for tests and hooks.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftFtestStrategies = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ALIASES = {
    airflow_setpoint: 'write_airflow_setpoint',
    flush_point: 'toggle_boolean',
    write_airflow_setpoint: 'write_airflow_setpoint',
    toggle_boolean: 'toggle_boolean',
    set_multistate: 'set_multistate',
    bas_toggle: 'bas_toggle',
    unsupported: 'unsupported',
  };

  const FLOW_SP = 'discharge_air_volume_flow_rate_setpoint';
  const FLOW = 'discharge_air_volume_flow_rate';
  const FLOW_MAX = 'discharge_air_volume_flow_rate_maximum';
  const PURGE = 'purge_operating_mode_command';
  const MAX_COOL = 'maximum_cooling_operating_mode_command';
  const TEST_MODE = 'test_operating_mode_command';

  /** @type {Map<string, any>} */
  const REGISTRY = new Map();

  /**
   * @param {any} strategy
   */
  function register(strategy) {
    if (!strategy || !strategy.id) throw new Error('strategy needs an id');
    REGISTRY.set(strategy.id, strategy);
    return strategy;
  }

  function list() {
    return [...REGISTRY.values()];
  }

  function get(id) {
    const key = ALIASES[id] || id;
    return REGISTRY.get(key) || null;
  }

  function canonical(id) {
    return ALIASES[id] || id || null;
  }

  /**
   * @param {any} equipment model equipment with points keyed by role, or an array of bound points
   * @param {string} role
   */
  function pointOf(equipment, role) {
    if (!equipment) return null;
    if (equipment.points && !Array.isArray(equipment.points)) return equipment.points[role] || null;
    const pts = Array.isArray(equipment.points) ? equipment.points : Array.isArray(equipment) ? equipment : [];
    return pts.find((/** @type {any} */ p) => p.role === role) || null;
  }

  function isWritable(point) {
    if (!point) return false;
    if (point.writable === true || point.actuatable === true) return true;
    const markers = point.haystack || point.markers || [];
    return Array.isArray(markers) && markers.includes('writable');
  }

  const writeAirflow = register({
    id: 'write_airflow_setpoint',
    name: 'Write airflow setpoint',
    summary: 'Command the box airflow setpoint to its cooling maximum, then release the command.',
    /**
     * @param {any} box
     * @param {any} [cfg]
     */
    resolve(box, cfg) {
      const sp = pointOf(box, (cfg && cfg.role) || FLOW_SP);
      const flow = pointOf(box, FLOW);
      const missing = [];
      if (!sp) missing.push('writable airflow setpoint (discharge_air_volume_flow_rate_setpoint)');
      else if (!isWritable(sp) && (cfg && cfg.writable) !== true) missing.push('airflow setpoint is not writable');
      if (!flow) missing.push('airflow sensor (discharge_air_volume_flow_rate)');
      if (missing.length) return { ok: false, strategy: 'write_airflow_setpoint', role: FLOW_SP, missing, reason: 'missing:' + missing.join(',') };
      return {
        ok: true,
        strategy: 'write_airflow_setpoint',
        role: FLOW_SP,
        equipment_id: box.id,
        missing: [],
        reason: null,
        why: 'This box has a writable airflow setpoint and an airflow sensor.',
      };
    },
    /**
     * @param {any} resolved
     * @param {{ target: number }} cmd
     */
    command(resolved, cmd) {
      return { equipment_id: resolved.equipment_id, role: resolved.role, value: cmd.target, release: 'cancel' };
    },
  });

  const toggleBoolean = register({
    id: 'toggle_boolean',
    name: 'Toggle boolean max-flow',
    summary: 'Write a boolean (or 0/1) flush / max-flow point on the box, then write the off value or cancel.',
    resolve(box, cfg) {
      const role = (cfg && cfg.role) || (pointOf(box, PURGE) ? PURGE : MAX_COOL);
      const pt = pointOf(box, role);
      const flow = pointOf(box, FLOW);
      const missing = [];
      if (!pt) missing.push(`boolean max-flow / flush command (${role})`);
      else if (!isWritable(pt) && (cfg && cfg.writable) !== true) missing.push(`${role} is not writable`);
      if (!flow) missing.push('airflow sensor (discharge_air_volume_flow_rate)');
      const on = cfg && cfg.on !== undefined ? cfg.on : 1;
      const off = cfg && cfg.off !== undefined ? cfg.off : 0;
      if (missing.length) return { ok: false, strategy: 'toggle_boolean', role, missing, reason: 'missing:' + missing.join(',') };
      return {
        ok: true,
        strategy: 'toggle_boolean',
        role,
        on,
        off,
        equipment_id: box.id,
        missing: [],
        reason: null,
        why: `This box has a writable boolean command (${role}) used as max-flow / flush.`,
      };
    },
    command(resolved) {
      return { equipment_id: resolved.equipment_id, role: resolved.role, value: resolved.on, release_value: resolved.off, release: 'write_then_cancel' };
    },
  });

  const setMultistate = register({
    id: 'set_multistate',
    name: 'Set box operating mode',
    summary: 'Write a multistate / enumerated box-mode point to its max-cooling state, then restore the release state or cancel.',
    resolve(box, cfg) {
      const role = (cfg && cfg.role) || TEST_MODE;
      const pt = pointOf(box, role);
      const flow = pointOf(box, FLOW);
      const missing = [];
      if (!pt) missing.push(`enumerated box-mode command (${role})`);
      else if (!isWritable(pt) && (cfg && cfg.writable) !== true) missing.push(`${role} is not writable`);
      if (!flow) missing.push('airflow sensor (discharge_air_volume_flow_rate)');
      const value = cfg && cfg.value !== undefined ? cfg.value : 1;
      const release = cfg && cfg.release !== undefined ? cfg.release : 0;
      if (missing.length) return { ok: false, strategy: 'set_multistate', role, missing, reason: 'missing:' + missing.join(',') };
      return {
        ok: true,
        strategy: 'set_multistate',
        role,
        value,
        release_value: release,
        equipment_id: box.id,
        missing: [],
        reason: null,
        why: `This box has a writable enumerated mode command (${role}) that can be set to max cooling.`,
      };
    },
    command(resolved) {
      return { equipment_id: resolved.equipment_id, role: resolved.role, value: resolved.value, release_value: resolved.release_value, release: 'write_then_cancel' };
    },
  });

  // Legacy AHU-level toggle: kept so existing site configs and plans keep working.
  register({
    id: 'bas_toggle',
    name: 'AHU-level maximum cooling mode',
    summary: 'Write a shared maximum-cooling mode point on the air handler (not a per-box write).',
    resolve(box, cfg, ctx) {
      const ahu = ctx && ctx.ahu;
      const pt = pointOf(ahu, MAX_COOL);
      const missing = [];
      if (!pt) missing.push('AHU maximum_cooling_operating_mode_command');
      else if (!isWritable(pt) && !(cfg && cfg.writable)) missing.push('AHU maximum cooling mode is not writable');
      if (missing.length) return { ok: false, strategy: 'bas_toggle', role: MAX_COOL, missing, reason: 'missing:' + missing.join(','), shared: true };
      return {
        ok: true,
        strategy: 'bas_toggle',
        role: MAX_COOL,
        equipment_id: ahu ? ahu.id : box.id,
        shared: true,
        on: cfg && cfg.on !== undefined ? cfg.on : 1,
        missing: [],
        reason: null,
        why: 'This site uses a shared AHU-level maximum cooling mode (not a per-box write).',
      };
    },
    command(resolved) {
      return { equipment_id: resolved.equipment_id, role: resolved.role, value: resolved.on, release: 'cancel', shared: true };
    },
  });

  register({
    id: 'unsupported',
    name: 'Unsupported',
    summary: 'No override strategy applies.',
    resolve(box) {
      return {
        ok: false,
        strategy: 'unsupported',
        role: null,
        equipment_id: box && box.id,
        missing: ['a writable airflow setpoint, boolean max-flow command, or enumerated box-mode command', 'airflow sensor'],
        reason: 'unsupported',
        why: 'No override strategy could be resolved from the model or site config.',
      };
    },
    command() { return null; },
  });

  /**
   * Auto-detect a per-box strategy when the site config does not name one.
   * Prefers an explicit vav_override, then writable airflow setpoint, then boolean flush, then enumerated mode.
   * @param {any} box
   * @param {any} [config] site config
   * @param {{ ahu?: any, order?: string[] }} [ctx]
   */
  function resolveBox(box, config, ctx) {
    const override = findOverride(config, box);
    if (override && override.strategy) {
      if (override.strategy === 'unsupported') return get('unsupported').resolve(box, override, ctx);
      const strat = get(override.strategy);
      if (!strat) {
        return { ok: false, strategy: 'unsupported', reason: 'unknown_strategy:' + override.strategy, missing: ['a known vav_override.strategy'], why: `Site config names strategy "${override.strategy}", which is not registered.`, equipment_id: box && box.id };
      }
      return strat.resolve(box, override, ctx);
    }
    const order = (ctx && ctx.order) || ['write_airflow_setpoint', 'toggle_boolean', 'set_multistate'];
    /** @type {any} */
    let last = null;
    for (const id of order) {
      const mapped = id === 'airflow_setpoint' ? 'write_airflow_setpoint' : id === 'flush_point' ? 'toggle_boolean' : id;
      if (mapped === 'bas_toggle') {
        last = get('bas_toggle').resolve(box, {}, ctx);
        if (last.ok) return last;
        continue;
      }
      const strat = get(mapped);
      if (!strat || mapped === 'unsupported') continue;
      const cfg = mapped === 'toggle_boolean' ? { role: pointOf(box, PURGE) ? PURGE : (pointOf(box, MAX_COOL) && !(ctx && ctx.ahu && pointOf(ctx.ahu, MAX_COOL) === pointOf(box, MAX_COOL)) ? MAX_COOL : PURGE) } : {};
      // Per-box boolean: only the box's own purge or max-cool point, not the AHU's.
      if (mapped === 'toggle_boolean' && !pointOf(box, PURGE) && !pointOf(box, MAX_COOL)) {
        last = strat.resolve(box, { role: PURGE }, ctx);
        continue;
      }
      const hit = strat.resolve(box, cfg, ctx);
      last = hit;
      if (hit.ok) return hit;
    }
    return last || get('unsupported').resolve(box, {}, ctx);
  }

  /**
   * @param {any} value
   */
  function normId(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  /**
   * Match a site-config equipment row to a box. Accepts a uuid, a Haystack id, or a
   * label whose first token is that id (so "vav-03" matches "VAV-03 Corridor").
   * @param {any} config
   * @param {any} boxOrId box object or id string
   */
  function findOverride(config, boxOrId) {
    if (!config || !boxOrId) return null;
    const box = typeof boxOrId === 'object' ? boxOrId : { id: boxOrId };
    const tokens = [box.id, box.tagId, box.haystackId, box.equipment_id, box.code, box.label]
      .filter(Boolean)
      .flatMap((/** @type {any} */ v) => [v, String(v).split(/\s+/)[0]]);
    const aliases = new Set(tokens.map(normId).filter(Boolean));
    const list = config.equipment || [];
    const item = list.find((/** @type {any} */ e) => {
      const cid = normId(e.id || e.equipment_id);
      return cid && (aliases.has(cid) || tokens.includes(e.id) || tokens.includes(e.equipment_id));
    });
    return item && item.vav_override ? item.vav_override : null;
  }

  void writeAirflow;
  void toggleBoolean;
  void setMultistate;

  return {
    ALIASES,
    FLOW_SP,
    FLOW,
    FLOW_MAX,
    PURGE,
    MAX_COOL,
    TEST_MODE,
    register,
    list,
    get,
    canonical,
    pointOf,
    isWritable,
    resolveBox,
    findOverride,
  };
});
