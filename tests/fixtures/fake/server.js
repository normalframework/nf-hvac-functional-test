'use strict';

const http = require('node:http');
const { DeviceObject } = require('./device');
const { seedAhu } = require('./ahu');
const { seedVav } = require('./vav');
const { VirtualClock } = require('./clock');
const { parseDurationMs } = require('../../../hooks/lib/nf/duration');
const fs = require('node:fs');
const path = require('node:path');

const RECORDED = path.join(__dirname, '..', 'nf-real');
const GENERIC_ERROR = 'type.googleapis.com/normalgw.hpl.v2.GenericError';
/** Routes the fake serves that real NF 3.10 does not have (recorded: 405 html). Mock-only. */
const MOCK_ONLY_ROUTES = Object.freeze([
  'POST /api/v2/bacnet/read',
  'POST /api/v2/bacnet/write',
  'POST /api/v1/point/upsert',
  'POST /api/v2/command/clear',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTML_SHELL = '<!doctype html><html><head><title>Normal Framework</title></head><body><div id="root"></div></body></html>';

/**
 * @param {string} id recorded fixture id
 */
function recorded(id) {
  return JSON.parse(fs.readFileSync(path.join(RECORDED, `${id}.json`), 'utf8'));
}

/**
 * In-band NF errors carry a message and no code. The mock code leads the message so tests can match it.
 * @param {string} code
 * @param {string} message
 */
function inband(code, message) {
  const text = `${code}: ${message}`;
  return { ts: new Date(0).toISOString(), message: text, error: { '@type': GENERIC_ERROR, message: text } };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} [options]
 */
function createFake(options = {}) {
  const clock = options.clock || new VirtualClock(Date.parse('2026-01-01T00:00:00Z'));
  /** @type {Map<string, DeviceObject>} */
  const points = new Map();
  /** @type {Map<number, any>} */
  const commands = new Map();
  /** @type {any[]} */
  const zombies = [];
  /** @type {Map<string, number>} */
  const names = new Map();
  let nextId = 1;
  const guardrails = options.guardrails !== false;
  const knownLayers = new Set(recorded('layers__list').response.body.layers.map((item) => item.name));
  const commandPriority = Object.prototype.hasOwnProperty.call(options, 'commandPriority')
    ? options.commandPriority
    : 8;
  /** @type {{ count: number, status?: number, drop?: boolean }} */
  const fault = { count: 0 };

  function expire() {
    const now = clock.now();
    for (const command of commands.values()) {
      if (!command.active || command.expiresAt > now) continue;
      revertCommand(command, true);
    }
  }

  /**
   * @param {any} command
   * @param {boolean} fromExpiry
   */
  function revertCommand(command, fromExpiry) {
    for (const write of command.writes) {
      const object = points.get(write.uuid);
      if (!object) continue;
      if (object.offline) {
        zombies.push({
          uuid: write.uuid,
          command_id: command.id,
          priority: write.priority,
          status: 'ZOMBIE_RETRYING',
          attempts: 1,
        });
        continue;
      }
      if (object.commandable) object.writeAt(write.priority, null);
    }
    command.active = false;
    command.endedAt = clock.now();
    names.delete(command.name);
    if (!fromExpiry) command.cancelled = true;
  }

  clock.onAdvance(() => expire());

  /**
   * @param {string} uuid
   * @param {number} priority
   * @param {number | boolean | null} value
   * @param {number} commandId
   */
  function applyWrite(uuid, priority, value, commandId) {
    const object = points.get(uuid);
    if (!object) return { error: { code: 'not_found', message: `unknown point ${uuid}` } };
    if (object.offline) return { error: { code: 'offline', message: `device offline ${uuid}` } };
    if (priority === 1 || priority === 2) {
      return { error: { code: 'priority_rejected', message: 'BACnet priorities 1 and 2 are rejected' } };
    }
    if (guardrails && object.unit === '%' && typeof value === 'number' && (value < 0 || value > 100)) {
      return { error: { code: 'guardrail', message: `guardrail rejected ${uuid}` } };
    }
    try {
      object.writeAt(priority, value);
    } catch (error) {
      const failed = /** @type {{ code?: string, message: string }} */ (error);
      return { error: { code: failed.code || 'write_failed', message: failed.message } };
    }
    return { uuid, priority, value, command_id: commandId };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    expire();
    if (fault.count > 0) {
      fault.count -= 1;
      if (fault.drop) {
        req.socket.destroy();
        return;
      }
      sendEmpty(res, fault.status || 503, 'application/grpc');
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      const body = await readBody(req);
      if (req.method === 'POST' && path === '/api/v2/command') return send(res, 200, startCommand(body));
      if (req.method === 'POST' && path === '/api/v2/command/write') return send(res, 200, writeCommand(body));
      if (req.method === 'POST' && path === '/api/v2/command/read') return send(res, 200, readCommand(body));
      if (req.method === 'GET' && path === '/api/v2/command') return send(res, 200, listCommands());
      if (req.method === 'POST' && path === '/api/v2/command/clear') return send(res, 200, clearCommand(body));
      if (req.method === 'GET' && path === '/api/v2/command/zombies') return send(res, 200, { zombies });
      const commandMatch = path.match(/^\/api\/v2\/command\/(\d+)$/);
      if (commandMatch && req.method === 'POST') return send(res, 200, extendCommand(Number(commandMatch[1]), body));
      if (commandMatch && req.method === 'DELETE') return send(res, 200, cancelCommand(Number(commandMatch[1])));
      if (req.method === 'POST' && path === '/api/v1/point/query') return send(res, 200, queryPoints(body));
      if (req.method === 'POST' && (path === '/api/v1/point/points' || path === '/api/v1/point/upsert')) return send(res, 200, upsertPoints(body));
      if (req.method === 'POST' && path === '/api/v1/points/data') return send(res, 200, addData(body));
      if (req.method === 'POST' && path === '/api/v2/bacnet/read') return send(res, 200, bacnetRead(body));
      if (req.method === 'POST' && path === '/api/v2/bacnet/write') return send(res, 200, bacnetWrite(body));
      if (req.method === 'GET' && path === '/api/v1/platform/env') return send(res, 200, environment());
      // Real NF serves its HTML app shell for unknown GET routes and answers 405 for other methods.
      if (req.method === 'GET') return sendHtml(res, 200);
      sendHtml(res, 405);
    } catch (error) {
      const failed = /** @type {{ status?: number, code?: string, message: string, grpc?: boolean }} */ (error);
      const status = failed.status || 400;
      res.setHeader('x-fake-reason', `${failed.code || 'bad_request'}: ${failed.message}`.replace(/[^\x20-\x7e]/g, ' '));
      // Real failures have empty bodies: text/plain for decode/validation, application/grpc for service errors.
      sendEmpty(res, status, status === 400 && !failed.grpc ? 'text/plain; charset=utf-8' : 'application/grpc');
    }
  }

  /**
   * Real NF ignores the `name` filter and returns every variable, identified by `id`.
   * The list is the recorded one; BACNET_PRIORITY carries this fake's configured priority.
   */
  function environment() {
    const variables = recorded('platform__env').response.body.variables
      .filter((item) => item.id !== 'BACNET_PRIORITY' || (commandPriority !== null && commandPriority !== undefined))
      .map((item) => (item.id === 'BACNET_PRIORITY' ? { ...item, integer: String(commandPriority) } : item));
    return { variables };
  }

  function startCommand(body) {
    only(body, ['name', 'duration']);
    const name = body.name;
    if (!name) fail(400, 'name_required', 'command name is required');
    if (names.has(name)) fail(409, 'already_exists', `command name in use ${name}`, true);
    // The wire takes a protobuf duration ("300s"); "48h" and "2m" are decode errors in real NF.
    const durationMs = /^\d+(\.\d+)?s$/.test(String(body.duration)) ? parseDurationMs(String(body.duration).replace(/\.\d+s$/, 's')) : NaN;
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > DAY_MS) {
      fail(400, 'lifetime', 'command lifetime must be within 24h');
    }
    const id = nextId;
    nextId += 1;
    const command = {
      id,
      name,
      startedAt: clock.now(),
      expiresAt: clock.now() + durationMs,
      writes: [],
      active: true,
    };
    commands.set(id, command);
    names.set(name, id);
    return { id: String(id), expiresAt: new Date(command.expiresAt).toISOString() };
  }

  /**
   * @param {any} body
   */
  function writeCommand(body) {
    only(body, ['command_id', 'writes', 'cancel_on_conflict']);
    const command = commands.get(Number(body.command_id));
    if (!command || !command.active) fail(404, 'not_found', 'command is not active', true);
    const writes = [];
    const errors = [];
    for (const write of body.writes || []) {
      only(write, ['point', 'value', 'priority']);
      only(write.point || {}, ['uuid', 'layer']);
      const uuid = write.point.uuid;
      const priority = Number(write.priority);
      const value = decodeValue(write.value);
      if (body.cancel_on_conflict || write.cancel_on_conflict) {
        const conflict = [...commands.values()].some((other) => other.active && other.id !== command.id
          && other.writes.some((item) => item.uuid === uuid));
        if (conflict) {
          errors.push({ point: write.point, error: inband('conflict', 'cancel_on_conflict') });
          continue;
        }
      }
      const result = applyWrite(uuid, priority, value, command.id);
      if (result.error) errors.push({ point: write.point, error: inband(result.error.code, result.error.message) });
      else {
        command.writes.push({ uuid, layer: write.point.layer, priority, value });
        writes.push(write);
      }
    }
    return { writes, errors };
  }

  /**
   * @param {any} body
   */
  function readCommand(body) {
    const results = [];
    const errors = [];
    for (const read of body.reads || []) {
      const object = points.get(read.point.uuid);
      if (!object) fail(400, 'not_found', 'unknown point', true);
      if (object.offline) {
        errors.push({ point: read.point, error: inband('offline', 'device offline') });
        continue;
      }
      const value = object.presentValue();
      results.push({
        point: read.point,
        scalar: value === null || value === undefined ? '' : String(value),
        ts: object.sampleTs || new Date(clock.now()).toISOString(),
      });
    }
    return { results, errors };
  }

  function listCommands() {
    const active = [...commands.values()].filter((command) => command.active);
    return {
      commands: active.map((command) => ({
        id: String(command.id),
        name: command.name,
        startedAt: new Date(command.startedAt).toISOString(),
        expiresAt: new Date(command.expiresAt).toISOString(),
        // Real NF shows a write it cannot apply in pendingWrites; successful rows are not recorded (mock-only shape).
        activeWrites: command.writes.map((write) => ({ point: { uuid: write.uuid, layer: write.layer }, priority: write.priority, value: write.value })),
        pendingWrites: [],
      })),
      totalCount: String(active.length),
    };
  }

  /**
   * @param {number} id
   * @param {any} body
   */
  function extendCommand(id, body) {
    only(body, ['new_expiration']);
    const command = commands.get(id);
    if (!command || !command.active) fail(404, 'not_found', 'command is not active', true);
    const expires = Date.parse(body.new_expiration);
    if (!Number.isFinite(expires) || expires <= clock.now() || expires - clock.now() > DAY_MS) {
      fail(400, 'lifetime', 'new expiration must be in the future and within 24h');
    }
    command.expiresAt = expires;
    return {};
  }

  /**
   * @param {number} id
   */
  function cancelCommand(id) {
    const command = commands.get(id);
    if (!command || !command.active) fail(404, 'not_found', 'command is not active', true);
    revertCommand(command, false);
    return {};
  }

  /**
   * @param {any} body
   */
  function clearCommand(body) {
    only(body, ['command_id', 'clears']);
    const command = commands.get(Number(body.command_id));
    if (!command || !command.active) fail(404, 'not_found', 'command is not active', true);
    const cleared = [];
    for (const item of body.clears || []) {
      const object = points.get(item.point.uuid);
      if (object && !object.offline && object.commandable) {
        const priorities = item.priority
          ? [item.priority]
          : command.writes.filter((write) => write.uuid === item.point.uuid).map((write) => write.priority);
        for (const priority of priorities) object.writeAt(priority, null);
      }
      if (object && object.offline) {
        zombies.push({ uuid: item.point.uuid, command_id: command.id, priority: item.priority, status: 'ZOMBIE_RETRYING', attempts: 1 });
      }
      command.writes = command.writes.filter((write) => write.uuid !== item.point.uuid);
      cleared.push(item);
    }
    return { cleared, errors: [] };
  }

  /**
   * @param {any} body
   */
  function queryPoints(body) {
    // Real NF: unknown fields (uuid, role, equipRef) are ignored; an unknown layer is a grpc 400.
    const layer = body.layer || 'default';
    if (layer !== 'default' && !knownLayers.has(layer)) fail(400, 'unknown_layer', String(layer), true);
    const field = body.structuredQuery && body.structuredQuery.field;
    const list = [...points.values()].filter((object) => {
      if (layer !== 'default' && object.layer !== layer) return false;
      if (field && String((object.attrs || {})[field.property] ?? '') !== String(field.text)) return false;
      return true;
    });
    const size = body.pageSize !== undefined ? Number(body.pageSize) : Number(body.page_size || 0);
    const offset = Number(body.pageOffset !== undefined ? body.pageOffset : body.page_offset || 0);
    if (!Number.isInteger(size) || size < 0) fail(400, 'page_size', 'negative page size', true);
    // NF returns no rows when pageSize is absent (totalCount still counts everything).
    const page = list.slice(offset, offset + size);
    return { points: page.map(describe), totalCount: String(list.length), nextPageToken: '' };
  }

  /**
   * @param {any} body
   */
  function upsertPoints(body) {
    // Real NF accepts a write without a base layer and applies nothing (a recorded quirk); the
    // fake mirrors that, and merges attrs into the named base layer when one is given.
    const results = [];
    for (const item of body.points || []) {
      const base = item.layer && item.layer !== 'default' && knownLayers.has(item.layer);
      if (base) {
        let object = points.get(item.uuid);
        if (!object) {
          object = new DeviceObject({
            uuid: item.uuid,
            layer: item.layer,
            type: item.type || 'ai',
            relinquish: item.relinquish ?? null,
            unit: item.unit || '',
            role: item.role || '',
          });
          points.set(item.uuid, object);
        }
        if (item.attrs) object.attrs = { ...(object.attrs || {}), ...item.attrs };
        if (item.period !== undefined) object.period = item.period;
      }
      results.push({ uuid: item.uuid, success: true, newVersion: '', taskUuid: 'points_updates_queue:mock' });
    }
    return { results };
  }

  /**
   * Real NF: POST /api/v1/points/data {points:[{uuid, values:[{ts, real}]}]} -> {success, taskUuid}.
   * @param {any} body
   */
  function addData(body) {
    for (const item of body.points || []) {
      if (!UUID_RE.test(String(item.uuid || ''))) fail(400, 'bad_uuid', String(item.uuid), true);
    }
    return { success: true, taskUuid: '' };
  }

  /**
   * @param {any} body
   */
  function bacnetRead(body) {
    const results = [];
    const errors = [];
    for (const read of body.reads || []) {
      const object = points.get(read.uuid);
      if (!object) {
        errors.push({ uuid: read.uuid, error: 'not_found' });
        continue;
      }
      if (object.offline) {
        errors.push({ uuid: read.uuid, error: 'offline' });
        continue;
      }
      const property = read.property || 'PRESENT_VALUE';
      if (property === 'PRIORITY_ARRAY') {
        results.push({ uuid: read.uuid, property, value: object.priorityArray() });
        continue;
      }
      results.push({ uuid: read.uuid, property, value: object.presentValue() });
    }
    return { results, errors };
  }

  /**
   * @param {any} body
   */
  function bacnetWrite(body) {
    only(body, ['writes']);
    const results = [];
    const errors = [];
    for (const write of body.writes || []) {
      only(write, ['uuid', 'layer', 'priority', 'value']);
      const priority = Number(write.priority);
      const value = write.value === undefined ? null : write.value;
      const result = applyWrite(write.uuid, priority, value, 0);
      if (result.error) errors.push({ uuid: write.uuid, error: result.error });
      else results.push({ uuid: write.uuid, priority, value });
    }
    return { results, errors };
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) send(res, 500, { error: { code: 'internal', message: error.message } });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        clock,
        points,
        commands,
        zombies,
        close: () => new Promise((done) => server.close(() => done(undefined))),
        seedAhu: (spec) => seedAhu(points, spec),
        seedVav: (spec) => seedVav(points, spec),
        /**
         * @param {number} count
         * @param {{ status?: number, drop?: boolean }} [mode]
         */
        failNext(count, mode = {}) {
          fault.count = count;
          fault.status = mode.status;
          fault.drop = mode.drop;
        },
        expire,
      });
    });
  });
}

/**
 * @param {DeviceObject} object
 */
function describe(object) {
  return {
    uuid: object.uuid,
    name: object.attrs && object.attrs.name ? String(object.attrs.name) : object.uuid,
    layer: object.layer,
    version: '',
    attrs: object.attrs || {},
    pointType: 'POINT',
  };
}

/**
 * @param {any} value
 */
function decodeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'real')) return value.real;
  if (Object.prototype.hasOwnProperty.call(value, 'boolean')) return value.boolean;
  if (Object.prototype.hasOwnProperty.call(value, 'enum')) return value.enum;
  if (Object.prototype.hasOwnProperty.call(value, 'null')) return null;
  return value;
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
/**
 * @param {any} body
 * @param {string[]} allowed
 */
function only(body, allowed) {
  const permit = new Set(allowed);
  for (const key of Object.keys(body || {})) {
    if (!permit.has(key)) fail(400, 'unknown_field', `unknown field ${key}`);
  }
}

/**
 * @param {number} status
 * @param {string} code mock-only reason, sent in x-fake-reason
 * @param {string} message
 * @param {boolean} [grpc] answer application/grpc instead of text/plain (400 only)
 */
function fail(status, code, message, grpc = false) {
  const error = /** @type {Error & { status: number, code: string, grpc: boolean }} */ (new Error(message));
  error.status = status;
  error.code = code;
  error.grpc = grpc;
  throw error;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} type
 */
function sendEmpty(res, status, type) {
  res.writeHead(status, { 'content-type': type });
  res.end();
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 */
function sendHtml(res, status) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML_SHELL);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 */
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        const error = /** @type {Error & { status: number, code: string }} */ (new Error('invalid JSON'));
        error.status = 400;
        error.code = 'bad_json';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

module.exports = { createFake, MOCK_ONLY_ROUTES, recorded, inband };
