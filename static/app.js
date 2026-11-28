// Page controller: picks live or demo data, polls status and commands, and drives the views.
// Demo mode only with ?demo=1. If the hooks cannot be reached the page says STATUS UNKNOWN; it never
// falls back to fixture data on its own.
(function (root) {
  'use strict';

  const g = /** @type {any} */ (root);
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const THEME_KEY = 'openfdd-ui-theme';

  function start() {
    const d = g.NfftDom;
    const params = new URLSearchParams(root.location.search);
    const demo = params.get('demo') === '1';
    const api = demo ? g.NfftDemo.create() : g.NfftApi.createLive();
    /** @type {any} */
    let status = null;
    let statusOk = false;
    /** @type {any} */
    let triggerView = null;
    /** @type {any} */
    let preview = null;
    /** @type {any} */
    let touch = null;
    /** @type {any[]} */
    let commands = [];
    let commandsAt = 0;
    let tab = params.get('tab') || 'overview';
    let pickStep = 0;
    let pickStage = '';
    /** @type {any} */
    let playTimer = null;
    let lastStepChart = '';
    const tz = () => (triggerView && triggerView.trigger && triggerView.trigger.rule.tz) || 'UTC';

    /**
     * @param {string} text
     * @param {boolean} [bad]
     */
    function notify(text, bad) {
      const box = $('err');
      box.textContent = text;
      box.className = bad ? 'banner bad-banner' : text ? 'banner' : '';
      if (text && !bad) setTimeout(() => { if (box.textContent === text) notify(''); }, 4000);
    }

    // Tabs.
    function showTab(/** @type {string} */ name) {
      tab = name;
      for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.tab === name);
      for (const s of document.querySelectorAll('section.tab')) s.classList.toggle('on', s.id === `tab-${name}`);
      renderTab();
    }
    for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => showTab(/** @type {HTMLElement} */ (b).dataset.tab || 'overview'));

    // Theme.
    $('themeBtn').addEventListener('click', () => {
      const next = d.themeName() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { root.localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
      lastStepChart = '';
      renderTab();
    });

    $('demoPill').hidden = !demo;
    if (demo) $('footer').textContent = 'Demo mode: fixture data from examples/site-config.example.json on a 60x clock. Nothing is sent to any station.';

    const machine = g.NfftMachineView.mount($('machineSvg'));
    /** @type {any} */
    let schedule;
    const graphic = g.NfftGraphicView.mount({
      api,
      demo,
      notify,
      onSystems(/** @type {{ id: string, label: string }[]} */ list) {
        if (schedule && typeof schedule.setSystems === 'function') schedule.setSystems(list);
      },
    });
    schedule = g.NfftScheduleView.mount({
      api,
      notify,
      onChange(/** @type {any} */ _saved, /** @type {any} */ view) {
        triggerView = view;
        renderBadge();
      },
    });

    /** Next runs with the blackout applied from the NF schedule the page loaded (fails closed if unreadable). */
    function upcoming() {
      if (!triggerView || !triggerView.trigger) return [];
      const sched = schedule.schedule();
      if (sched === undefined) return triggerView.next_runs || [];
      return g.NfftTrigger.preview(g.NfftTrigger.normalize(triggerView.trigger), Date.now(), sched, 6);
    }

    function nextRunAt() {
      const runs = upcoming();
      const next = runs.find((/** @type {any} */ r) => r.runs !== false) || runs[0];
      if (!next) return undefined;
      // Demo status runs on a fast clock; the trigger preview is wall time.
      return demo ? api.now() + (next.at - Date.now()) : next.at;
    }

    const active = () => statusOk && status && !['IDLE', 'COMPLETE', 'ABORTED', 'FAILED'].includes(status.state);

    function renderBadge() {
      const badge = $('modeBadge');
      const mode = triggerView && triggerView.trigger ? triggerView.trigger.mode : null;
      let cls = 'unknown';
      let text = 'STATUS UNKNOWN';
      let sub = 'cannot reach the app hooks';
      if (statusOk && mode) {
        if (active() && status.dry_run === false) {
          cls = 'armed'; text = 'LIVE RUN'; sub = 'overrides are being written';
        } else if (mode === 'armed') {
          cls = 'armed'; text = 'ARMED'; sub = 'next occurrence runs live';
        } else if (mode === 'dry_run') {
          cls = 'dry'; text = 'DRY RUN'; sub = 'scheduled rehearsal, no writes';
        } else {
          cls = 'disabled'; text = 'TRIGGER OFF'; sub = 'manual runs only';
        }
        if (active() && status.dry_run !== false && mode !== 'armed') sub = 'rehearsal in progress, no writes';
      }
      badge.className = `mode-badge ${cls}`;
      $('modeText').textContent = text;
      $('modeSub').textContent = sub;
      $('unknownBanner').hidden = statusOk;
      $('abortBtn').hidden = !active();
    }

    function card(/** @type {string} */ name, /** @type {string} */ value, /** @type {string} */ desc, /** @type {boolean} */ small) {
      return d.el('div', { class: 'card' }, d.el('div', { class: 'name', text: name }), d.el('div', { class: small ? 'val small' : 'val', text: value }), d.el('div', { class: 'desc', text: desc }));
    }

    function renderCards(/** @type {any} */ view) {
      const off = !triggerView || !triggerView.trigger || triggerView.trigger.mode === 'disabled';
      const next = off ? null : upcoming().find((/** @type {any} */ r) => r.runs !== false);
      const devices = touch ? touch.devices.length : 0;
      const written = touch ? touch.devices.reduce((/** @type {number} */ a, /** @type {any} */ x) => a + x.written, 0) : 0;
      d.fill($('overviewCards'),
        card('State', statusOk ? view.label : 'unknown', statusOk ? (status.run_id || 'no run') : 'status not reachable', true),
        card('Next scheduled run', next ? next.local : '—', next ? next.utc : 'trigger disabled', true),
        card('Rule', triggerView ? triggerView.describe : '—', triggerView ? triggerView.trigger.mode.replace('_', ' ') : '', true),
        card('Touches', `${devices} devices`, `${written} points written · priority ${preview ? preview.priority : '—'}`, true),
        card('Active commands', String(commands.length), commands.length ? 'each expires on its own' : 'nothing overridden', false),
        card('Plan length', touch ? d.duration(touch.total_ms) : '—', preview ? `lease ${preview.lease_s}s, renewed while running` : '', true));
    }

    function renderCommands() {
      const now = api.now();
      d.fill($('commands'), commands.length ? d.el('table', { class: 'bac' },
        d.el('thead', {}, d.el('tr', {}, ...['Command', 'Writes', 'Expires in', ''].map((h) => d.el('th', { text: h })))),
        d.el('tbody', {}, ...commands.map((c) => {
          const exp = Date.parse(c.expires_at || c.expiresAt || c.expiration || '');
          const left = Number.isFinite(exp) ? exp - now : NaN;
          const lease = c.lease_ms || (preview ? preview.lease_s * 1000 : 0);
          const bar = d.el('i');
          if (lease && Number.isFinite(left)) bar.style.width = `${Math.max(0, Math.min(100, (left / lease) * 100)).toFixed(0)}%`;
          return d.el('tr', {},
            d.el('td', { class: 'mono', text: c.name }),
            d.el('td', { class: 'num', text: String(c.writes !== undefined ? c.writes : (c.writes_list || c.points || []).length || '') }),
            d.el('td', {}, d.el('span', { class: 'cmd-left', text: Number.isFinite(left) ? g.NfftStateView.formatCountdown(left) : 'no expiry reported' }), d.el('div', { class: 'cmd-bar' }, bar)),
            d.el('td', { class: 'sub', text: 'auto-reverts at expiry' }));
        })))
        : d.el('p', { class: 'muted', text: statusOk ? 'No ftest commands are active. Nothing is overridden.' : 'Unknown: the command list could not be read.' }));
    }

    function renderOverview() {
      const view = g.NfftStateView.view(statusOk ? status : { state: 'IDLE' }, {
        now: api.now(),
        nextRunAt: nextRunAt(),
        triggerMode: triggerView && triggerView.trigger ? triggerView.trigger.mode : 'disabled',
      });
      machine.update(view);
      $('stateLabel').textContent = statusOk ? view.label : 'STATUS UNKNOWN';
      $('stateDetail').textContent = statusOk ? view.detail : 'The page cannot confirm the run state.';
      $('machineHint').textContent = statusOk && status.dry_run !== false && active() ? 'dry run: nothing is written' : '';
      g.NfftMachineView.rings($('rings'), statusOk ? view.countdowns : []);
      $('attentionBox').hidden = !view.attention;
      renderCards(view);
      renderCommands();
      const steps = (preview && preview.steps) || [];
      let elapsed = null;
      if (active() && status.step_index >= 0 && status.step_started_at > 0) {
        const before = steps.slice(0, status.step_index).reduce((/** @type {number} */ a, /** @type {any} */ s) => a + (s.hold_ms || 0), 0);
        elapsed = before + Math.max(0, api.now() - status.step_started_at);
      }
      const key = `${steps.length}|${elapsed === null ? '' : Math.round(elapsed / 30000)}|${d.themeName()}`;
      if (key !== lastStepChart) {
        lastStepChart = key;
        g.NfftHistoryView.stepChart($('stepChart'), steps, elapsed);
      }
    }

    function renderEquipment() {
      if (!touch) {
        d.fill($('airpath'), d.el('p', { class: 'muted', text: 'Plan preview not available yet.' }));
        return;
      }
      const steps = (preview && preview.steps) || [];
      if (!pickStep) {
        const running = active() && status.step_index >= 0 ? status.step_index + 1 : 0;
        pickStep = running || (steps.findIndex((/** @type {any} */ s) => (s.writes || []).length) + 1) || 1;
      }
      if (!pickStage) pickStage = 'outdoor';
      d.fill($('stepPick'), ...steps.map((/** @type {any} */ s, /** @type {number} */ i) => d.el('button', {
        type: 'button', class: pickStep === i + 1 ? 'on' : '', text: `${i + 1} ${s.step_id}`,
        title: `hold ${d.duration(s.hold_ms)}${s.settle_ms ? `, settle ${d.duration(s.settle_ms)}` : ''}, ${(s.writes || []).length} writes`,
        onclick: () => { stopPlay(); pickStep = i + 1; renderEquipment(); },
      })));
      g.NfftAirPath.draw($('airpath'), touch, pickStep, pickStage, (/** @type {string} */ stage) => { pickStage = stage; renderEquipment(); }, preview.units || {});
      g.NfftAirPath.detail($('stageDetail'), touch, pickStage, preview.units || {});
      g.NfftAirPath.devices($('devices'), touch, preview.units || {});
      d.fill($('skipped'), ...(touch.skipped.length ? [d.el('b', { text: 'Skipped steps: ' }), ...touch.skipped.map((/** @type {any} */ s) => d.el('span', { class: 'pill', text: `${s.step_id}: ${s.reason}` }))]
        : [d.el('span', { class: 'muted', text: `${touch.dry_run ? 'Site config is dry run: steps are planned and logged, nothing is written.' : 'Site config allows live writes when a run is confirmed or armed.'} Priority ${touch.priority}, lease ${touch.lease_s}s.` })]));
    }

    function stopPlay() {
      if (playTimer) clearInterval(playTimer);
      playTimer = null;
      $('playBtn').textContent = 'Play the sequence';
    }
    $('playBtn').addEventListener('click', () => {
      if (playTimer) { stopPlay(); return; }
      const n = ((preview && preview.steps) || []).length;
      if (!n) return;
      $('playBtn').textContent = 'Stop';
      pickStep = 1;
      renderEquipment();
      playTimer = setInterval(() => {
        pickStep = pickStep >= n ? 1 : pickStep + 1;
        renderEquipment();
      }, 2200);
    });

    async function renderHistory() {
      const runs = demo ? api.history() : [];
      const decisions = triggerView && triggerView.trigger ? triggerView.trigger.history : [];
      g.NfftHistoryView.render($('historyChart'), $('historyTable'), g.NfftHistoryView.rows(runs, decisions), tz());
      /** @type {Record<string, any[]>} */
      const byHook = {};
      for (const hook of ['trigger', 'tick']) {
        try { byHook[hook] = await api.hookRuns(hook); } catch { byHook[hook] = []; }
      }
      g.NfftHistoryView.hookRuns($('hookRuns'), byHook);
    }

    function renderTab() {
      renderBadge();
      if (tab === 'overview') renderOverview();
      else if (tab === 'equipment') renderEquipment();
      else if (tab === 'history') renderHistory();
      else if (tab === 'schedule') schedule.refresh();
      if (tab === 'graphic') graphic.activate();
      else graphic.deactivate();
    }

    let statusDelay = 8000;
    function nextStatusDelay() {
      if (demo) return 1000;
      if (statusOk && active()) return 2000;
      if (statusOk) return 8000;
      return Math.min(30000, Math.max(8000, statusDelay * 2));
    }
    async function pollStatus() {
      try {
        status = await api.status();
        statusOk = Boolean(status && status.ok !== false && status.state);
        if (graphic && graphic.setStatus) graphic.setStatus(status);
      } catch (err) {
        statusOk = false;
      }
      statusDelay = nextStatusDelay();
      if (Date.now() - commandsAt > (demo ? 900 : (statusOk ? 15000 : 30000))) {
        commandsAt = Date.now();
        try { commands = await api.commands(); } catch { commands = []; }
      }
      renderBadge();
    }
    function loopStatus() {
      setTimeout(async () => {
        await pollStatus();
        loopStatus();
      }, statusDelay);
    }

    /**
     * @param {() => Promise<any>} call
     * @param {string} done
     */
    async function act(call, done) {
      try {
        const reply = await call();
        if (reply && reply.ok === false) notify(`Refused: ${reply.code || reply.error || 'unknown'}`, true);
        else notify(done);
      } catch (err) {
        notify(String(/** @type {any} */ (err).message || err), true);
      }
      await pollStatus();
      renderTab();
    }
    $('abortBtn').addEventListener('click', () => {
      if (root.confirm('Abort the run and release every override now?')) act(() => api.abort(), 'Abort requested. Overrides are being released.');
    });
    $('retryBtn').addEventListener('click', () => act(() => api.retryRelease(), 'Release retried.'));
    $('ackBtn').addEventListener('click', () => act(() => api.acknowledge(), 'Acknowledged.'));

    async function boot() {
      showTab(tab);
      await pollStatus();
      try {
        schedule.load(await api.trigger('get'));
      } catch (err) {
        notify(`Trigger settings not available: ${/** @type {any} */ (err).message || err}`, true);
      }
      try {
        preview = await api.planPreview();
        if (preview && preview.ok !== false) touch = g.NfftTouchMap.build(preview);
        else notify(`Plan preview refused: ${(preview && preview.code) || 'unknown'}`, true);
      } catch (err) {
        notify(`Plan preview not available: ${/** @type {any} */ (err).message || err}`, true);
      }
      lastStepChart = '';
      renderTab();
      loopStatus();
      setInterval(() => { if (tab === 'overview') renderOverview(); else renderBadge(); }, 1000);
      setInterval(() => { if (tab === 'history') renderHistory(); }, 30000);
      if (params.get('play') === '1' && tab === 'equipment') $('playBtn').click();
      g.NfftGraphicDebug = graphic;
    }
    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(globalThis);
