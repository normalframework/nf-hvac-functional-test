'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createFake } = require('./fake/server');
const { NfClient } = require('../lib/nf/client');
const { adminAction, createSession, tick, bindRelease } = require('../lib/admin');
const { readStatus, abortRequest, readAbort } = require('../lib/status_page');
const onTick = require('../hooks/tick');
const onRequest = require('../hooks/admin');

function stubRunner() {
  const runner = {
    state: { phase: 'IDLE', stepIndex: -1, runId: '', needsAttention: false },
    manifest: { overrides: [], dry_run: true },
    attention: 0,
    vavReport: [],
    async start(id) {
      this.state.phase = 'BASELINE';
      this.state.runId = id;
      this.state.stepIndex = 0;
    },
    async abort() {
      this.state.phase = 'ABORTED';
    },
    async retryRelease() {
      this.state.phase = 'RELEASING';
    },
    async acknowledge() {
      this.state.needsAttention = false;
      this.state.phase = 'IDLE';
    },
  };
  return runner;
}

test('admin actions validate, discover, start, abort, and acknowledge', async () => {
  const fake = await createFake();
  try {
    fake.seedAhu({ points: { outdoor_air_intake_temperature: '00000000-0000-4000-8000-000000000301' } });
    const client = new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} });
    let writes = 0;
    const original = client.writeInCommand.bind(client);
    client.writeInCommand = async (body) => {
      writes += 1;
      return original(body);
    };
    const session = createSession();
    session.client = client;
    session.factory = async (args) => {
      if (args.confirm_live !== true && args.live === true) return null;
      return stubRunner();
    };
    const example = JSON.parse(fs.readFileSync('examples/site-config.example.json', 'utf8'));
    const valid = await adminAction(session, 'config', { op: 'validate', config: example });
    assert.equal(valid.ok, true);
    const bad = await adminAction(session, 'config', { op: 'validate', config: { version: 1, write: { bacnet_priority: 1 } } });
    assert.equal(bad.ok, false);
    const found = await adminAction(session, 'config', { op: 'discover', query: { uuid: '00000000-0000-4000-8000-000000000301' } });
    assert.equal(found.writes, 0);
    assert.equal(found.count, 1);
    const open = await adminAction(session, 'config', { op: 'discover' });
    assert.equal(open.code, 'query_unbounded');
    assert.equal(open.writes, 0);
    assert.equal(writes, 0);
    const refused = await adminAction(session, 'start', { live: true, confirm_live: false, run_id: 'run_no' });
    assert.equal(refused.code, 'confirm_live');
    assert.equal(writes, 0);
    const started = await adminAction(session, 'start', { confirm_live: true, run_id: 'run_operator' });
    assert.equal(started.state, 'BASELINE');
    const held = await adminAction(session, 'start', { confirm_live: true });
    assert.equal(held.code, 'run_active');
    const view = await adminAction(session, 'status');
    assert.equal(view.run_id, 'run_operator');
    assert.ok(session.runner);
    session.runner.state.needsAttention = true;
    const released = await adminAction(session, 'retry_release');
    assert.equal(released.state, 'RELEASING');
    const acked = await adminAction(session, 'acknowledge');
    assert.equal(acked.state, 'IDLE');
    const aborted = await adminAction(session, 'abort');
    assert.equal(aborted.state, 'ABORTED');
    assert.equal((await adminAction(session, 'nope')).code, 'unknown_action');

    const sdk = {
      options: { enabled: true },
      globals: {},
      signals: {},
      setGlobal(name, value) { this.globals[name] = value; },
      onSignal(signal, fn) { this.signals[signal] = fn; },
    };
    onTick.useSession(session);
    onRequest.useSession(session);
    const globals = await onTick(sdk);
    assert.equal(globals.ftest_state, 'ABORTED');
    assert.equal(sdk.globals.ftest_needs_attention, 0);
    sdk.signals.SIGTERM();
    const hooked = await onRequest({
      args: { action: 'status', payload: '{}' },
    });
    assert.equal(hooked.state, 'ABORTED');
    sdk.options.enabled = false;
    const skipped = await tick(sdk, session);
    assert.equal(skipped.skipped, true);
    let releasedOnSignal = 0;
    bindRelease({ onSignal(_s, fn) { fn(); } }, () => { releasedOnSignal += 1; });
    assert.equal(releasedOnSignal, 1);
  } finally {
    await fake.close();
  }
});

test('the operator page has the safety elements, no inline code, and serves', async () => {
  const html = fs.readFileSync('static/index.html', 'utf8');
  for (const id of ['modeBadge', 'modeText', 'stateLabel', 'rings', 'abortBtn', 'unknownBanner', 'attentionBox', 'retryBtn', 'ackBtn', 'commands', 'armDialog', 'armAck', 'armPhrase', 'armConfirm', 'weekGrid', 'airpath', 'devices', 'historyTable']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /STATUS UNKNOWN/);
  assert.match(html, /Content-Security-Policy[^>]+script-src 'self'/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
  assert.doesNotMatch(html, /\sstyle=/, 'no inline styles');
  assert.doesNotMatch(html, /\son[a-z]+=/, 'no inline handlers');
  assert.match(html, /id="armConfirm" disabled/);
  for (const src of html.matchAll(/(?:src|href)="([^"?#:]+)"/g)) {
    assert.ok(fs.existsSync(path.join('static', src[1])), `missing ${src[1]}`);
  }
  const app = fs.readFileSync('static/js/app.js', 'utf8');
  assert.match(app, /params\.get\('demo'\) === '1'/, 'demo mode only on request');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/`);
    const body = await reply.text();
    assert.equal(reply.status, 200);
    assert.match(body, /Dry-run is the default/);
    assert.match(body, /Abort and release/);
    const unknown = await readStatus(null);
    assert.equal(unknown.state, 'status unknown');
    assert.equal(unknown.show_dry_run, false);
    const live = await readStatus({ ok: true, async json() { return { state: 'STEP', dry_run: false }; } });
    assert.equal(live.show_dry_run, false);
    const dry = await readStatus({ ok: true, async json() { return { state: 'STEP', dry_run: true }; } });
    assert.equal(dry.show_dry_run, true);
    const call = abortRequest();
    const seen = await new Promise((resolve) => {
      const hook = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, state: 'RELEASING' }));
          resolve({ method: req.method, url: req.url, body: JSON.parse(raw) });
        });
      });
      hook.listen(0, '127.0.0.1', async () => {
        const address = hook.address();
        const hookPort = typeof address === 'object' && address ? address.port : 0;
        const reply = await fetch(`http://127.0.0.1:${hookPort}${call.url}`, {
          method: call.method,
          headers: call.headers,
          body: JSON.stringify(call.body),
        });
        const parsed = await readAbort(reply);
        assert.equal(parsed.release, 'RELEASING');
        hook.close();
      });
    });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/v1/hooks/admin/invoke');
    assert.deepEqual(seen.body, { args: { action: 'abort' } });
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
