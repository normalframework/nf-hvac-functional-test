'use strict';

const http = require('node:http');
const { DeviceObject } = require('./device');
const { seedAhu } = require('./ahu');
const { seedVav } = require('./vav');
const { VirtualClock } = require('./clock');
const { parseDurationMs } = require('../../../hooks/lib/nf/duration');

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
      send(res, fault.status || 503, { error: { code: 'unavailable', message: 'injected failure' } });
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const body = await readBody(req);
    const path = url.pathname;
    try {
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
      if (req.method === 'POST' && path === '/api/v1/point/upsert') return send(res, 200, upsertPoints(body));
      if (req.method === 'POST' && path === '/api/v1/data') return send(res, 200, addData(body));
      if (req.method === 'POST' && path === '/api/v2/bacnet/read') return send(res, 200, bacnetRead(body));
      if (req.method === 'POST' && path === '/api/v2/bacnet/write') return send(res, 200, bacnetWrite(body));
      if (req.method === 'GET' && path === '/api/v1/platform/env') return send(res, 200, environment(url));
      send(res, 404, { error: { code: 'not_found', message: path } });
    } catch (error) {
      const failed = /** @type {{ status?: number, code?: string, message: string }} */ (error);
      const status = failed.status || 400;
      send(res, status, { error: { code: failed.code || 'bad_request', message: failed.message } });
    }
  }

  /**
   * @param {any} body
   */
  /**
   * @param {URL} url
   */
  function environment(url) {
    const name = url.searchParams.get('name');
    if (name !== 'BACNET_PRIORITY' || commandPriority === null || commandPriority === undefined) {
      return { variables: [] };
    }
    return {
      variables: [{
        name: 'BACNET_PRIORITY',
        section: 'command',
        description: 'The default BACnet priority level to use for writes',
        integer: String(commandPriority),
      }],
    };
  }

  function startCommand(body) {
    only(body, ['name', 'duration']);
    const name = body.name;
    if (!name) fail(400, 'name_required', 'command name is required');
    if (names.has(name)) fail(409, 'already_exists', `command name in use ${name}`);
    const durationMs = parseDurationMs(body.duration);
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
    return { id, expires_at: new Date(command.expiresAt).toISOString() };
  }

  /**
   * @param {any} body
   */
  function writeCommand(body) {
    only(body, ['command_id', 'writes', 'cancel_on_conflict']);
    const command = commands.get(Number(body.command_id));
    if (!command || !command.active) fail(404, 'not_found', 'command is not active');
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
          errors.push({ point: write.point, error: { code: 'conflict', message: 'cancel_on_conflict' } });
          continue;
        }
      }
      const result = applyWrite(uuid, priority, value, command.id);
      if (result.error) errors.push({ point: write.point, error: result.error });
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
      if (!object) {
        errors.push({ point: read.point, error: { code: 'not_found', message: 'unknown point' } });
        continue;
      }
      if (object.offline) {
        errors.push({ point: read.point, error: { code: 'offline', message: 'device offline' } });
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
    return { commands: active, total_count: active.length };
  }

  /**
   * @param {number} id
   * @param {any} body
   */
  function extendCommand(id, body) {
    only(body, ['new_expiration']);
    const command = commands.get(id);
    if (!command || !command.active) fail(404, 'not_found', 'command is not active');
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
    if (!command || !command.active) fail(404, 'not_found', 'command is not active');
    revertCommand(command, false);
    return {};
  }

  /**
   * @param {any} body
   */
  function clearCommand(body) {
    only(body, ['command_id', 'clears']);
    const command = commands.get(Number(body.command_id));
    if (!command || !command.active) fail(404, 'not_found', 'command is not active');
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
    const list = [...points.values()].filter((object) => {
      if (body.layer && object.layer !== body.layer) return false;
      if (body.uuid && object.uuid !== body.uuid) return false;
      if (body.role && object.role !== body.role) return false;
      return true;
    });
    return { points: list.map(describe) };
  }

  /**
   * @param {any} body
   */
  function upsertPoints(body) {
    const saved = [];
    for (const item of body.points || []) {
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
      if (item.attrs) object.attrs = item.attrs;
      if (item.period !== undefined) object.period = item.period;
      saved.push(describe(object));
    }
    return { points: saved };
  }

  /**
   * @param {any} body
   */
  function addData(body) {
    const batches = body.batches || body.points || [];
    return { accepted: batches.length };
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
    layer: object.layer,
    type: object.type,
    unit: object.unit,
    role: object.role,
    present_value: object.offline ? null : object.presentValue(),
    commandable: object.commandable,
    period: object.period,
    attrs: object.attrs || {},
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

function fail(status, code, message) {
  const error = /** @type {Error & { status: number, code: string }} */ (new Error(message));
  error.status = status;
  error.code = code;
  throw error;
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
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

module.exports = { createFake };
