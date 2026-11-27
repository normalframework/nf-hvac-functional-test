// NF access for the page. Same-origin /api/v1/* calls, the same hook pattern as the Open-FDD NF app:
// POST /api/v1/apps/<app>/hooks/<hook> starts a run, the answer is read from that run's results.
// Reads only, except the admin hook actions an operator clicks (abort, retry, acknowledge, trigger edits).
// Browser global NfftApi.
(function (root) {
  'use strict';

  const DEFAULT_APP = 'nf-hvac-functional-test';

  function appId() {
    const match = /\/api\/v1\/apps\/static\/([^/]+)\//.exec(root.location ? root.location.pathname : '');
    return match ? decodeURIComponent(match[1]) : DEFAULT_APP;
  }

  /**
   * @param {string} path
   * @param {any} [body]
   * @param {string} [method]
   */
  async function api(path, body, method) {
    const init = { method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers: /** @type {Record<string, string>} */ ({}) };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      /** @type {any} */ (init).body = JSON.stringify(body);
    }
    const reply = await fetch(path, /** @type {RequestInit} */ (init));
    if (!reply.ok) throw new Error(`${path} -> HTTP ${reply.status}`);
    const text = await reply.text();
    return text ? JSON.parse(text) : {};
  }

  /**
   * The hook's answer: a group's return value, or the last JSON event message.
   * @param {any} run
   */
  function answerOf(run) {
    const groups = Object.values((run && run.results) || {});
    for (const group of groups) {
      const typed = /** @type {any} */ (group);
      for (const key of ['returnValue', 'return_value', 'result', 'value']) {
        const raw = typed && typed[key];
        if (raw && typeof raw === 'object') return raw;
        if (typeof raw === 'string' && raw.trim().startsWith('{')) return JSON.parse(raw);
      }
    }
    const events = groups.flatMap((g) => /** @type {any} */ (g).events || []);
    const last = [...events].reverse().find((e) => typeof e.message === 'string' && e.message.trim().startsWith('{'));
    if (last) return JSON.parse(last.message);
    return null;
  }

  /**
   * StartHook arguments are a string map.
   * @param {string} hook
   * @param {Record<string, any>} args
   */
  async function callHook(hook, args) {
    const app = encodeURIComponent(appId());
    const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    const started = await api(`/api/v1/apps/${app}/hooks/${hook}`, body);
    const pid = started.pid;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((ok) => setTimeout(ok, i === 0 ? 300 : 700));
      const runs = (await api(`/api/v1/apps/${app}/hooks/${hook}/runs?page_size=5&include_results=true&include_logs=true`)).runs || [];
      const run = runs.find((/** @type {any} */ r) => r.pid === pid);
      if (!run || ['STATE_RUNNING', 'STATE_ENQUEUED', 'STATE_SCHEDULED'].includes(run.state)) continue;
      const answer = answerOf(run);
      if (!answer) throw new Error(`${hook} hook ended ${run.state} without an answer`);
      return answer;
    }
    throw new Error(`${hook} hook is still running`);
  }

  /**
   * @param {string} action
   * @param {any} [payload]
   */
  function admin(action, payload) {
    return callHook('admin', { action, payload: payload || {} });
  }

  function createLive() {
    return {
      kind: 'live',
      now: () => Date.now(),
      status: () => admin('status'),
      trigger: (/** @type {string} */ op, /** @type {any} */ payload) => admin('trigger', { ...(payload || {}), op }),
      planPreview: () => admin('plan_preview'),
      abort: () => admin('abort'),
      retryRelease: () => admin('retry_release'),
      acknowledge: () => admin('acknowledge'),
      async commands() {
        const body = await api('/api/v2/command');
        return (body.commands || []).filter((/** @type {any} */ c) => String(c.name || '').startsWith('ftest-'));
      },
      async schedules() {
        const body = await api('/api/v1/schedules?pageOffset=0&pageSize=200&hideEmpty=false');
        return (body.schedules || []).map((/** @type {any} */ s) => ({ uuid: s.uuid, name: s.name || s.uuid }));
      },
      schedule: (/** @type {string} */ uuid) => api(`/api/v1/schedules/${encodeURIComponent(uuid)}`),
      async hookRuns(/** @type {string} */ hook) {
        const app = encodeURIComponent(appId());
        const body = await api(`/api/v1/apps/${app}/hooks/${hook}/runs?page_size=15`);
        return body.runs || [];
      },
    };
  }

  root.NfftApi = { appId, answerOf, createLive };
})(globalThis);
