'use strict';

class NfError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {any} body
   */
  constructor(message, status, body) {
    super(message);
    this.name = 'NfError';
    this.status = status;
    this.body = body;
  }
}

class NfClient {
  /**
   * @param {{ baseUrl: string, fetch?: typeof fetch, retries?: number, sleep?: (ms: number) => Promise<void> }} options
   */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.retries = options.retries === undefined ? 3 : options.retries;
    this.sleep = options.sleep || (async () => {});
  }

  /**
   * @param {{ uuid: string, layer: string }[]} refs
   */
  readPoints(refs) {
    return this.request('/api/v2/command/read', {
      method: 'POST',
      body: { reads: refs.map((point) => ({ point })) },
    });
  }

  /**
   * @param {Record<string, unknown>} query
   */
  queryPoints(query) {
    return this.request('/api/v1/point/query', { method: 'POST', body: query });
  }

  /**
   * @param {any[]} points
   */
  upsertPoints(points) {
    return this.request('/api/v1/point/points', { method: 'POST', body: { points } });
  }

  /**
   * @param {any} batch
   */
  addData(batch) {
    return this.request('/api/v1/data', { method: 'POST', body: batch });
  }

  /**
   * @param {{ name: string, duration: string }} spec
   */
  startCommand(spec) {
    return this.request('/api/v2/command', {
      method: 'POST',
      body: { name: spec.name, duration: spec.duration },
    });
  }

  /**
   * @param {{ command_id: number, writes: any[], cancel_on_conflict?: boolean }} spec
   */
  writeInCommand(spec) {
    return this.request('/api/v2/command/write', { method: 'POST', body: spec });
  }

  /**
   * @param {number} id
   * @param {string} newExpiration
   */
  extendCommand(id, newExpiration) {
    return this.request(`/api/v2/command/${id}`, {
      method: 'POST',
      body: { new_expiration: newExpiration },
    });
  }

  /**
   * @param {number} id
   */
  cancelCommand(id) {
    return this.request(`/api/v2/command/${id}`, { method: 'DELETE' });
  }

  listCommands() {
    return this.request('/api/v2/command', { method: 'GET' });
  }

  /**
   * The command service's process-wide BACnet priority.
   * NF documents this as the BACNET_PRIORITY environment variable, default 12,
   * and exposes platform env through GET /api/v1/platform/env.
   * A missing route or an empty list means this NF build did not expose it.
   * @returns {Promise<number | null>}
   */
  async readCommandPriority() {
    let body;
    try {
      body = await this.request('/api/v1/platform/env?name=BACNET_PRIORITY', { method: 'GET' });
    } catch (error) {
      if (error instanceof NfError && (error.status === 404 || error.status === 400)) return null;
      throw error;
    }
    const variables = Array.isArray(body.variables) ? body.variables : [];
    const match = variables.find((item) => item && item.name === 'BACNET_PRIORITY');
    if (!match) return null;
    const raw = match.integer !== undefined ? match.integer : match.string;
    const priority = Number(raw);
    if (!Number.isInteger(priority)) return null;
    return priority;
  }

  /**
   * One NF schedule (ScheduleManager, read only).
   * @param {string} uuid
   */
  getSchedule(uuid) {
    return this.request(`/api/v1/schedules/${encodeURIComponent(uuid)}`, { method: 'GET' });
  }

  listZombies() {
    return this.request('/api/v2/command/zombies', { method: 'GET' });
  }

  /**
   * @param {{ uuid: string, layer?: string }} point
   */
  async readPriorityArray(point) {
    const reply = await this.bacnetRead([{ uuid: point.uuid, property: 'PRIORITY_ARRAY' }]);
    const row = (reply.results || []).find((item) => item.uuid === point.uuid);
    return row ? row.value : null;
  }

  /**
   * @param {{ uuid: string, property?: string }[]} reads
   */
  bacnetRead(reads) {
    return this.request('/api/v2/bacnet/read', { method: 'POST', body: { reads } });
  }

  /**
   * @param {{ uuid: string, layer?: string, value: number | boolean | null, priority: number }} spec
   */
  bacnetWrite(spec) {
    return this.request('/api/v2/bacnet/write', {
      method: 'POST',
      body: { writes: [spec] },
    });
  }

  /**
   * @param {string} path
   * @param {{ method: string, body?: any }} spec
   */
  async request(path, spec) {
    let lastError = new NfError('request failed', 0, null);
    const attempts = Math.max(1, this.retries);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: spec.method,
          headers: spec.body === undefined ? {} : { 'content-type': 'application/json' },
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) : {};
        if (response.status >= 500 && attempt < attempts) {
          await this.sleep(0);
          lastError = new NfError(`status ${response.status}`, response.status, body);
          continue;
        }
        if (!response.ok) throw new NfError(body.error?.message || `status ${response.status}`, response.status, body);
        return body;
      } catch (error) {
        if (error instanceof NfError && error.status < 500) throw error;
        const message = error instanceof Error ? error.message : String(error);
        lastError = error instanceof NfError ? error : new NfError(message, 0, null);
        if (attempt < attempts) await this.sleep(0);
      }
    }
    throw lastError;
  }
}

module.exports = { NfClient, NfError };
