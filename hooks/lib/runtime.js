'use strict';

const path = require('node:path');
const { validateSiteConfig } = require('./config');
const { Ledger } = require('./ledger');
const { loadHaystackMap, loadHaystackModel } = require('./model');
const { NfClient } = require('./nf/client');
const { buildPlan } = require('./plan');
const { getRole, roleAllowsWrite } = require('./roles');
const { Runner } = require('./runner');

/**
 * Directory that holds state.json. Tests inject session.root and never use this.
 * @returns {string}
 */
function defaultStateRoot() {
  if (process.env.NF_HVAC_STATE_DIR) return process.env.NF_HVAC_STATE_DIR;
  return path.join(__dirname, '..', '..', 'local');
}

/**
 * @param {any} sdk
 */
function nfBaseUrl(sdk) {
  const fromOption = sdk && sdk.options && sdk.options.nfBaseUrl;
  if (typeof fromOption === 'string' && fromOption) return fromOption;
  if (process.env.NF_BASE_URL) return process.env.NF_BASE_URL;
  return 'http://127.0.0.1:8080';
}

/**
 * A discover or binding query must name one equipment or one point.
 * @param {any} query
 */
function boundedQuery(query) {
  if (!query || typeof query !== 'object') return null;
  if (typeof query.uuid === 'string' && query.uuid) {
    return { uuid: query.uuid };
  }
  if (typeof query.equip_ref !== 'string' || !query.equip_ref) return null;
  /** @type {Record<string, unknown>} */
  const body = { equip_ref: query.equip_ref };
  if (Array.isArray(query.markers)) body.markers = query.markers;
  if (typeof query.layer === 'string') body.layer = query.layer;
  return body;
}

/**
 * Explicit uuid bindings become the model. No site-wide point query.
 * @param {any} config
 */
function modelFromBindings(config) {
  const equipment = [];
  const points = [];
  for (const item of config.equipment || []) {
    equipment.push({
      id: item.id,
      type: item.type,
      serves: item.serves || [],
      tags: [item.type],
    });
    for (const [roleId, binding] of Object.entries(item.points || {})) {
      const typed = /** @type {any} */ (binding);
      if (typeof typed.uuid !== 'string') continue;
      const role = getRole(roleId);
      const unit = typeof typed.unit === 'string' && typed.unit
        ? typed.unit
        : (role && role.unit) || null;
      points.push({
        uuid: typed.uuid,
        layer: typed.layer,
        equipRef: item.id,
        unit,
        tags: roleTags(roleId),
        attrs: {
          equipRef: item.id,
          writable: typed.writable === true && role && roleAllowsWrite(role) ? 'm:' : undefined,
        },
      });
    }
  }
  return loadHaystackModel({ equipment, points });
}

/**
 * Tag set that binds this role and no longer one, taken from the shipped map.
 * @param {string} roleId
 */
function roleTags(roleId) {
  const map = loadHaystackMap();
  const entry = (map.roles || []).find((item) => item.role === roleId);
  return entry ? entry.tags.slice() : [roleId];
}

/**
 * Resolve query bindings one equipment at a time. Zero or several matches stay unbound.
 * @param {any} config
 * @param {{ queryPoints: (query: any) => Promise<any> }} client
 */
async function resolveQueryBindings(config, client) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const item of copy.equipment || []) {
    for (const [roleId, binding] of Object.entries(item.points || {})) {
      const typed = /** @type {any} */ (binding);
      if (typeof typed.uuid === 'string') continue;
      const query = boundedQuery(typed.query);
      if (!query) {
        const error = new Error(`unbounded query for ${roleId}`);
        /** @type {any} */ (error).code = 'query_unbounded';
        throw error;
      }
      const reply = await client.queryPoints(query);
      const found = reply.points || [];
      if (found.length !== 1) continue;
      typed.uuid = found[0].uuid;
      if (!typed.layer && found[0].layer) typed.layer = found[0].layer;
    }
  }
  return copy;
}

/**
 * @param {any} session
 * @param {any} sdk
 */
function createFactory(session, sdk) {
  return async function factory(args) {
    try {
      const parsed = parseSiteConfig(sdk);
      if (!parsed) {
        session.last_error = 'site_config';
        return null;
      }
      const validated = validateSiteConfig(parsed);
      if (!validated.ok) {
        session.last_error = 'site_config';
        return null;
      }
      const client = session.client || new NfClient({ baseUrl: nfBaseUrl(sdk), sleep: async () => {} });
      const resolved = await resolveQueryBindings(validated.config, client);
      // A scheduled dry-run rehearsal is dry-run even when the site policy allows live writes.
      let config = args && args.dry_run === true ? { ...resolved, dry_run: true } : resolved;
      if (args && args.system_id) config = { ...config, _system_id: args.system_id };
      if (args && args.test_id) {
        const hold = Number(args.hold_minutes);
        config = {
          ...config,
          plan: {
            ...config.plan,
            steps: [
              { step_id: args.test_id, enabled: true, hold_minutes: Number.isFinite(hold) && hold > 0 ? hold : 30, settle_minutes: 5 },
              { step_id: 'recovery', enabled: true, hold_minutes: 1, settle_minutes: 0 },
            ],
          },
        };
      }
      const model = modelFromBindings(config);
      const plan = buildPlan(model, config);
      const ledger = new Ledger(path.join(session.root, 'ledger'));
      return new Runner({
        client,
        ledger,
        config,
        plan,
        model,
        clock: { now: () => Date.now() },
        confirmLive: args.confirm_live === true,
        sleep: async () => {},
      });
    } catch (error) {
      const code = error && /** @type {any} */ (error).code;
      session.last_error = code === 'query_unbounded' ? 'query_unbounded' : 'site_config';
      return null;
    }
  };
}

/**
 * @param {any} sdk
 */
function parseSiteConfig(sdk) {
  const target = require('./signoff').targetOf({ ...((sdk && sdk.config) || {}), ...((sdk && sdk.options) || {}) });
  // Simulation target: only the config the sim hook built for its own objects. Live target: only the reviewed
  // siteConfig option. Neither falls back to the other.
  if (target === 'simulation') return simulatorConfig(sdk);
  const raw = sdk && sdk.options ? sdk.options.siteConfig : '';
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return target === 'live' ? null : simulatorConfig(sdk);
  return JSON.parse(raw);
}

/**
 * No siteConfig option: when the office simulator is armed, use the config the sim hook wrote for the objects it
 * owns (sim_site_config.js). Otherwise null, so a real site never runs without its own reviewed config.
 * @param {any} sdk
 */
function simulatorConfig(sdk) {
  const options = { ...((sdk && sdk.config) || {}), ...((sdk && sdk.options) || {}) };
  const sim = require('./sim');
  if (!sim.isArmed(options)) return null;
  const layout = String(sim.unwrapOption ? sim.unwrapOption(options.simulatorLayout) || 'office' : options.simulatorLayout || 'office');
  if (layout.trim() === 'demo') return null;
  return require('./sim_site_config').load(sdk.stateRoot || defaultStateRoot());
}

/**
 * Production hooks have no injected factory. Tests that set one are left alone.
 * @param {any} session
 * @param {any} sdk
 */
function ensureRuntime(session, sdk) {
  if (sdk && (sdk.options || sdk.config)) session.options = { ...(sdk.config || {}), ...(sdk.options || {}) };
  if (session.factory) return session;
  if (!session.root) session.root = defaultStateRoot();
  session.factory = createFactory(session, sdk);
  return session;
}

module.exports = {
  defaultStateRoot,
  nfBaseUrl,
  boundedQuery,
  modelFromBindings,
  resolveQueryBindings,
  createFactory,
  ensureRuntime,
  parseSiteConfig,
};
