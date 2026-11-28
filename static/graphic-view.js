// Functional test graphic: a passive 3D view of live NF values, built from the 223P model.
// The deterministic sim is used only in ?demo=1. The only operator input here is test duration
// (plus Start / Abort-and-release). Browser global NfftGraphicView.
(function (root) {
  'use strict';

  const g = /** @type {any} */ (root);
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const STATIC_LIMIT_PA = 750;
  const idOf = (/** @type {any} */ r) => (r.attrs || {}).id || r.name;
  const DEMO_HOLD_MS = 20000; // accelerated hold in demo (represents the chosen minutes)

  const loaded = new Map();
  function loadScript(/** @type {string} */ src) {
    if (!loaded.has(src)) {
      loaded.set(src, new Promise((ok, fail) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => ok(true);
        s.onerror = () => fail(new Error(`${src} did not load`));
        document.head.appendChild(s);
      }));
    }
    return loaded.get(src);
  }

  let oxigraphReady = /** @type {Promise<any>|null} */ (null);
  function oxigraph() {
    if (!oxigraphReady) {
      const base = new URL('vendor/oxigraph/', document.baseURI).href;
      oxigraphReady = import(/* webpackIgnore: true */ `${base}web.js`).then(async (mod) => {
        await mod.default({ module_or_path: `${base}web_bg.wasm` });
        return mod;
      });
    }
    return oxigraphReady;
  }

  /**
   * @param {{ api: any, demo: boolean, notify: (text: string, bad?: boolean) => void }} o
   */
  function mount(o) {
    const D = g.NfftDom;
    const T = g.NfftGraphic;
    const S = g.NfftS223;
    const Sys = g.NfftSystems;
    const F = g.NfftFtest;
    const Def = g.NfftDeficiencies;
    /** @type {any} */ let source = null;
    /** @type {any} */ let current = null;
    /** @type {any} */ let groups = { systems: [], unassigned: [], warnings: [] };
    /** @type {any} */ let scene = null;
    /** @type {any} */ let timer = null;
    /** @type {any} */ let recheck = null;
    let active = false;
    let booting = /** @type {Promise<any>|null} */ (null);
    /** @type {any} */ let status = null;
    /** @type {any} */ let demoRun = null;
    let holdMin = F.DEFAULT_HOLD_MIN;
    let selectedId = '';

    async function deps() {
      await Promise.all([loadScript('vendor/open-fdd/paging.js'), loadScript('vendor/open-fdd/model.js')]);
      const ox = await oxigraph();
      const modelJs = { toPoint: g.toPoint, modelToTurtle: g.modelToTurtle, rdfBaseOf: g.rdfBaseOf };
      if (typeof modelJs.modelToTurtle !== 'function') throw new Error('Open-FDD model.js did not load');
      return { ox, modelJs };
    }

    async function scenarios() {
      if (!o.demo || !o.api.demoRecords) return [];
      const r = await o.api.demoRecords();
      return (r.scenarios || []).map((/** @type {any} */ x) => {
        const rec = r.model.find((/** @type {any} */ m) => idOf(m) === x.equipRef);
        return rec ? { equip: rec.uuid, part: x.part, spec: x.spec } : null;
      }).filter(Boolean);
    }

    async function boot() {
      const { ox, modelJs } = await deps();
      const scen = await scenarios();
      source = g.NfftModelSource.createModelSource({
        callOpenFddHook: o.api.openFddHook || null,
        loadRecords: () => g.NfftModelSource.loadRecords(o.api.queryAll, idOf),
        modelJs,
        build: (/** @type {string} */ turtle) => g.NfftTags223p.buildModel(turtle, { oxigraph: ox, s223: S, vocab: g.NfftRoles223p, bind: g.NfftHaystackBind, scenarios: scen }),
      });
      await refresh(true);
    }

    async function refresh(/** @type {boolean} */ force) {
      let got;
      try {
        got = await source.get({ force });
      } catch (err) {
        D.fill($('graphicSource'), D.el('span', { class: 'pill bad', text: 'model unavailable' }), ' ', String(/** @type {any} */ (err).message || err));
        return;
      }
      groups = Sys.fromModel(got.model);
      renderSource(got);
      renderOverview();
      if (got.rebuilt || !current) await build(got.model);
    }

    function renderSource(/** @type {any} */ got) {
      const m = got.model;
      const label = got.source === 'open-fdd' ? 'Open-FDD graph (shared)' : 'Built-in graph from NF tags';
      D.fill($('graphicSource'),
        D.el('span', { class: `pill ${got.source === 'open-fdd' ? 'ok' : ''}`, text: label }), ' ',
        D.el('span', { class: 'muted', text: `snapshot ${got.snapshot.slice(0, 10)} · ${groups.systems.length} air system${groups.systems.length === 1 ? '' : 's'} · ${m.bindings.length} points bound · checked ${new Date(got.checkedAt).toLocaleTimeString()}` }),
        got.note ? D.el('div', { class: 'hint', text: got.note }) : null,
        groups.warnings.length ? D.el('div', { class: 'hint warn', text: groups.warnings.join(' · ') }) : null);
      const pick = /** @type {HTMLSelectElement} */ ($('graphicUnit'));
      const prev = selectedId || pick.value;
      const opts = [
        ...groups.systems.map((/** @type {any} */ a) => D.el('option', { value: a.id, text: `${a.label} · ${a.terminals.length} terminals` })),
        groups.unassigned.length ? D.el('option', { value: 'unassigned', text: `Unassigned · ${groups.unassigned.length} terminal${groups.unassigned.length === 1 ? '' : 's'} (not testable)` }) : null,
      ];
      D.fill(pick, opts);
      if (prev && (groups.systems.some((/** @type {any} */ a) => a.id === prev) || prev === 'unassigned')) pick.value = prev;
      selectedId = pick.value;
    }

    function renderOverview() {
      const host = $('systemOverview');
      if (!host) return;
      const cards = groups.systems.map((/** @type {any} */ s) => {
        const run = systemRun(s.id);
        const assess = current && current.assessById && current.assessById[s.id];
        const st = run && run.active ? 'active' : (run && run.outcome ? run.outcome : 'idle');
        return D.el('button', { type: 'button', class: `sys-card ${st}${s.id === selectedId ? ' on' : ''}`, 'data-id': s.id },
          D.el('b', { text: s.label }),
          D.el('span', { class: 'muted', text: `${s.terminals.length} VAVs` }),
          D.el('span', { class: `pill ${st}`, text: run && run.active ? 'TEST ACTIVE' : (run && run.outcome ? String(run.outcome).toUpperCase() : 'passive') }),
          assess ? D.el('span', { class: 'hint', text: `${assess.tests.find((/** @type {any} */ t) => t.test === 'vav.max_cool')?.testable || 0} testable for max cooling` }) : null);
      });
      if (groups.unassigned.length) {
        cards.push(D.el('button', { type: 'button', class: `sys-card unassigned${selectedId === 'unassigned' ? ' on' : ''}`, 'data-id': 'unassigned' },
          D.el('b', { text: 'Unassigned' }),
          D.el('span', { class: 'muted', text: `${groups.unassigned.length} VAV${groups.unassigned.length === 1 ? '' : 's'}` }),
          D.el('span', { class: 'pill', text: 'not testable until mapped' })));
      }
      D.fill(host, D.el('h2', { text: 'Site systems' }, D.el('span', { class: 'hint', text: 'one plugin, every air handler in the model' })), D.el('div', { class: 'sys-row' }, cards));
      host.querySelectorAll('button[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id') || '';
          /** @type {HTMLSelectElement} */ ($('graphicUnit')).value = id;
          selectedId = id;
          if (current) build(current.model);
        });
      });
    }

    function systemRun(/** @type {string} */ id) {
      if (demoRun && demoRun.systemId === id) return demoRun;
      if (status && status.system_id === id) {
        const activeRun = status.state && !['IDLE', 'COMPLETE', 'ABORTED', 'FAILED'].includes(status.state);
        return { active: activeRun, outcome: activeRun ? null : (status.state || '').toLowerCase(), status };
      }
      const row = status && status.systems && status.systems.find((/** @type {any} */ s) => s.id === id);
      if (row) return { active: row.active, outcome: row.outcome, status: row };
      return null;
    }

    async function liveValues(/** @type {any} */ unit) {
      if (o.demo && o.api.demoRecords) {
        const r = await o.api.demoRecords();
        const out = {};
        for (const p of r.points) out[p.uuid] = { value: p.latestValue, ts: p.latestTs || null };
        return out;
      }
      try {
        const pts = unit ? S.points(unit) : [];
        const plants = (current && current.model && current.model.plants) || [];
        const extra = plants.flatMap((/** @type {any} */ p) => (p.props || []).map((/** @type {any} */ q) => q.id).filter(Boolean));
        const uuids = [...new Set(pts.map((/** @type {any} */ p) => p.id).concat(extra))];
        if (g.NfftModelSource.loadValues) return g.NfftModelSource.loadValues(o.api.queryAll, { uuids, equipIds: equipIds(unit) });
        const recs = await g.NfftModelSource.loadRecords(o.api.queryAll, idOf);
        const want = new Set(uuids);
        return Object.fromEntries(recs.points.filter((/** @type {any} */ p) => want.has(p.uuid)).map((/** @type {any} */ p) => [p.uuid, { value: p.latestValue, ts: p.latestTs || (p.attrs || {}).lastTs || null }]));
      } catch {
        return {};
      }
    }

    function equipIds(/** @type {any} */ unit) {
      const ids = [];
      if (unit) {
        if (unit.id) ids.push(unit.id);
        for (const t of unit.terminals || []) ids.push(t.id);
      }
      return ids;
    }

    async function build(/** @type {any} */ model) {
      const pick = /** @type {HTMLSelectElement} */ ($('graphicUnit'));
      selectedId = pick.value || selectedId;
      const isUnassigned = selectedId === 'unassigned';
      const system = Sys.find(groups, selectedId);
      const unit = isUnassigned ? null : (system && system.unit);
      if (!unit && !isUnassigned) {
        D.fill($('graphicStage'), D.el('div', { class: 'empty', text: 'No air handler in the model. Tag an ahu equipment and its points in NF.' }));
        return;
      }
      const values = await liveValues(unit);
      const layout = unit ? T.layout(unit, S.points, model) : { casing: null, elements: [], terminals: [], ducts: [], intakes: [], pipes: [], plants: [], pointPart: {}, center: [0, 0, 0] };
      /** @type {Record<string, any>} */
      const assessById = {};
      for (const s of groups.systems) assessById[s.id] = F.assessSystem(s.unit, { points: S.points, config: o.api.siteConfig });
      current = { model, unit, layout, values, system, isUnassigned, assessById };
      renderIdleNote();
      renderCanTest();
      renderDeficiencies();
      renderLive();
      renderTestPanel();
      renderOverview();
      await renderScene();
    }

    function renderIdleNote() {
      const el = $('graphicIdleNote');
      if (!el) return;
      const run = selectedId && systemRun(selectedId);
      if (run && run.active) el.textContent = 'A functional test is running on this system. Live values are still display-only except the test’s guarded writes.';
      else if (current && current.isUnassigned) el.textContent = 'These terminals have no feed relationship to an air handler. They are shown for mapping, and are not testable until they are linked.';
      else el.textContent = 'Passive view of live NF values. Nothing on this tab writes unless you start a test (dry-run by default).';
    }

    async function renderScene() {
      if (scene) scene.dispose();
      if (current.isUnassigned || !current.unit) {
        D.fill($('graphicStage'), D.el('div', { class: 'empty' },
          D.el('p', { text: 'Unassigned terminals (no airRef / feed to an AHU):' }),
          D.el('ul', {}, groups.unassigned.map((/** @type {any} */ t) => D.el('li', { text: t.label || t.id })))));
        scene = null;
        return;
      }
      const theme = D.themeName ? D.themeName() : (document.documentElement.getAttribute('data-theme') || 'dark');
      const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const mod = await import(/** @type {string} */ ('./graphic-scene.js'));
      scene = mod.createGraphicScene($('graphicStage'), current.layout, {
        pressureColor: T.pressureColor,
        staticLimitPa: STATIC_LIMIT_PA,
        preserveDrawingBuffer: true,
        theme,
        reducedMotion: reduced,
      });
      scene.update(frameNow(), marksNow());
    }

    function frameNow() {
      if (demoRun && demoRun.frame) return demoRun.frame;
      if (!current || !current.unit) return { t: 0, values: {}, scene: { fanOn: false, fanSpeed: 0, staticPa: 0, totalLps: 0, oaFraction: 0, terminals: [] } };
      return T.liveFrame(current.unit, S.points, current.values);
    }

    function marksNow() {
      const def = (current && current.deficiencies) || [];
      const faulted = def.filter((/** @type {any} */ d) => d.severity === 'fail').map((/** @type {any} */ d) => d.part).filter(Boolean);
      const overridden = (demoRun && demoRun.overriddenParts) || (status && status.override_parts) || [];
      return { overridden, faulted };
    }

    function renderCanTest() {
      const host = $('graphicCanTest');
      if (!host) return;
      if (current.isUnassigned) {
        D.fill(host, D.el('h3', { text: 'What can be tested' }), D.el('p', { class: 'hint', text: 'Nothing here is testable until each terminal is mapped to an air handler with a feed relationship (airRef, feeds / isFedBy, or a 223P air connection).' }));
        return;
      }
      const assess = F.assessSystem(current.unit, { points: S.points, config: o.api.siteConfig });
      current.assess = assess;
      const blocks = assess.tests.map((/** @type {any} */ t) => {
        const rows = (t.boxes || []).map((/** @type {any} */ b) => D.el('tr', { class: b.ok ? '' : 'bad-row' },
          D.el('td', { text: b.label }),
          D.el('td', { class: 'mono', text: b.ok ? (b.strategy || '') : 'unsupported' }),
          D.el('td', { text: b.ok ? (b.why || 'Ready') : `Missing: ${(b.missing || []).join('; ')}` })));
        return D.el('div', { class: 'can-test' },
          D.el('h3', { text: t.name || t.test }, D.el('span', { class: `pill ${t.ok ? 'ok' : ''}`, text: t.ok ? `${t.testable}/${t.total} testable` : 'not testable' })),
          t.ahu && t.ahu.missing && t.ahu.missing.length ? D.el('p', { class: 'hint', text: `AHU missing: ${t.ahu.missing.join(', ')}` }) : null,
          D.el('table', { class: 'bac' },
            D.el('thead', {}, D.el('tr', {}, ['Equipment', 'Strategy', 'Why / missing'].map((h) => D.el('th', { text: h })))),
            D.el('tbody', {}, rows)));
      });
      D.fill(host, D.el('h3', { text: 'What can be tested' }), blocks);
    }

    function renderDeficiencies() {
      const host = $('graphicDeficiencies');
      if (!host || !current.unit) {
        if (host) D.fill(host, D.el('h3', { text: 'Deficiencies' }), D.el('p', { class: 'hint', text: 'None.' }));
        return;
      }
      const pts = S.points(current.unit);
      const failed = (demoRun && demoRun.report && demoRun.report.results || []).filter((/** @type {any} */ r) => !r.ok && !r.skipped)
        .flatMap((/** @type {any} */ r) => (r.deficiencies || []).map((/** @type {any} */ d) => ({ ...d, equipment_id: r.equipment_id, label: r.label, message: d.message })));
      const sys = (demoRun && demoRun.report && demoRun.report.systemDeficiencies) || [];
      const found = Def.detect(pts, current.values, { failedSteps: failed.concat(sys.map((/** @type {any} */ d) => ({ kind: d.kind, message: d.message, equipment_id: current.unit.id, label: current.unit.label }))) });
      current.deficiencies = found;
      const list = found.length ? D.el('ul', { class: 'def-list' }, found.map((/** @type {any} */ d) => {
        const a = D.el('button', { type: 'button', class: 'link', text: d.label });
        a.addEventListener('click', () => highlight(d.part));
        return D.el('li', { class: d.severity }, a, ' — ', d.message);
      })) : D.el('p', { class: 'hint', text: 'No deficiencies on this system right now.' });
      D.fill(host, D.el('h3', { text: 'Deficiencies' }), list);
    }

    function highlight(/** @type {string|null} */ part) {
      if (!scene || !part) return;
      scene.update(frameNow(), { overridden: [], faulted: [part] });
    }

    function renderLive() {
      const host = $('graphicPoints');
      if (!host) return;
      if (!current.unit) { D.fill(host, ''); return; }
      const pts = S.points(current.unit);
      const rows = pts.map((/** @type {any} */ p) => {
        const raw = current.values[p.id];
        const v = raw && typeof raw === 'object' ? raw.value : raw;
        return D.el('tr', {},
          D.el('td', { text: p.part_label || p.part }), D.el('td', { text: p.label }), D.el('td', { class: 'mono', text: p.role || 'unbound' }),
          D.el('td', { class: 'mono', text: v === undefined || v === null ? '—' : String(v) }),
          D.el('td', { text: p.actuatable ? 'writable role' : 'read' }));
      });
      D.fill(host, D.el('table', { class: 'bac' },
        D.el('thead', {}, D.el('tr', {}, ['Equipment', 'Point (NF)', 'Open-FDD role', o.demo ? 'Value (demo)' : 'NF value (read-only)', 'Kind'].map((h) => D.el('th', { text: h })))),
        D.el('tbody', {}, rows)));
    }

    function renderTestPanel() {
      const host = $('graphicTestPanel');
      if (!host) return;
      const assess = current.assess || (current.unit ? F.assessSystem(current.unit, { points: S.points, config: o.api.siteConfig }) : null);
      const can = assess && assess.tests && assess.tests.some((/** @type {any} */ t) => t.test === 'vav.max_cool' && t.ok);
      const running = !!(demoRun && demoRun.active);
      const dur = D.el('select', { id: 'graphicDuration', 'aria-label': 'Test duration' },
        F.HOLD_CHOICES.map((/** @type {number} */ m) => D.el('option', { value: String(m), text: `${m} minutes`, selected: m === holdMin ? 'selected' : undefined })));
      /** @type {HTMLSelectElement} */ (dur).value = String(holdMin);
      dur.addEventListener('change', () => { holdMin = Number(/** @type {HTMLSelectElement} */ (dur).value) || F.DEFAULT_HOLD_MIN; });
      const start = D.el('button', { class: 'btn primary', type: 'button', text: 'Start VAV max cooling', disabled: (!can || running || current.isUnassigned) ? 'disabled' : undefined });
      start.addEventListener('click', () => startMaxCooling());
      D.fill(host,
        D.el('h3', { text: 'VAV max cooling airflow' }),
        D.el('p', { class: 'hint', text: 'The only test input is duration. Everything else is a passive display of live values.' }),
        D.el('label', { class: 'duration' }, D.el('span', { text: 'Hold duration' }), dur),
        start,
        !can && !current.isUnassigned ? D.el('p', { class: 'hint warn', text: 'This system has no testable VAV for max cooling. See what is missing in the panel below.' }) : null);
      renderBanner();
    }

    function renderBanner() {
      const host = $('testBanner');
      if (!host) return;
      const liveStatus = !o.demo && status && status.state && !['IDLE', 'COMPLETE', 'ABORTED', 'FAILED'].includes(status.state);
      const run = demoRun && demoRun.active ? demoRun : (liveStatus ? { active: true, systemId: status.system_id || selectedId, label: 'Functional test', endsAt: (status.step_started_at || 0) + (((status.steps || [])[status.step_index] || {}).hold_ms || 0), holdMin } : null);
      if (!run || !run.active) {
        host.hidden = true;
        D.fill(host);
        const abortBtn = $('abortBtn');
        if (abortBtn) abortBtn.hidden = true;
        return;
      }
      host.hidden = false;
      const left = Math.max(0, (run.endsAt || 0) - Date.now());
      const mm = Math.floor(left / 60000);
      const ss = Math.floor((left % 60000) / 1000);
      const count = run.demo ? `${ss}s (demo of a ${run.holdMin} min hold)` : `${mm}:${String(ss).padStart(2, '0')}`;
      const abort = D.el('button', { class: 'btn danger', type: 'button', text: 'Abort and release' });
      abort.addEventListener('click', () => abortRun(false));
      const abortAll = D.el('button', { class: 'btn', type: 'button', text: 'Abort all systems' });
      abortAll.addEventListener('click', () => abortRun(true));
      D.fill(host,
        D.el('div', { class: 'test-banner-inner' },
          D.el('b', { text: 'FUNCTIONAL TEST ACTIVE' }),
          D.el('span', { text: `${run.systemLabel || run.systemId || ''} · ${run.label || 'VAV max cooling airflow'}` }),
          D.el('span', { class: 'countdown', text: `Hold remaining ${count}` }),
          abort, abortAll));
      const abortBtn = $('abortBtn');
      if (abortBtn) abortBtn.hidden = false;
    }

    async function startMaxCooling() {
      if (!current || !current.unit) return;
      holdMin = Number((/** @type {HTMLSelectElement|null} */ ($('graphicDuration')) || { value: F.DEFAULT_HOLD_MIN }).value) || F.DEFAULT_HOLD_MIN;
      if (o.demo) {
        startDemoRun();
        return;
      }
      try {
        const reply = await o.api.start({ test_id: 'vav.max_cool', system_id: current.unit.id, hold_minutes: holdMin, live: false });
        if (reply && reply.ok === false) o.notify(`Refused: ${reply.code || reply.error || 'unknown'}`, true);
        else o.notify('Max cooling test queued (dry-run by default). Overrides will be released at the end or on abort.');
      } catch (err) {
        o.notify(String(/** @type {any} */ (err).message || err), true);
      }
    }

    function startDemoRun() {
      const assess = F.assessSystem(current.unit, { points: S.points, config: o.api.siteConfig });
      const cool = assess.tests.find((/** @type {any} */ t) => t.test === 'vav.max_cool');
      const started = Date.now();
      const endsAt = started + DEMO_HOLD_MS;
      const pts = S.points(current.unit);
      const values = { ...current.values };
      const set = (/** @type {string} */ equip, /** @type {string} */ role, /** @type {any} */ value) => {
        const p = pts.find((q) => q.equipment === equip && q.role === role);
        if (p) values[p.id] = { value, ts: Date.now() };
      };
      const get = (/** @type {string} */ equip, /** @type {string} */ role) => {
        const p = pts.find((q) => q.equipment === equip && q.role === role);
        if (!p) return null;
        const v = values[p.id];
        return v && typeof v === 'object' ? Number(v.value) : Number(v);
      };
      // Capacity: one box is deliberately starved (scenario or the last testable box).
      const starved = (current.model.scenarios || []).map((/** @type {any} */ s) => s.part)[0] || (cool.boxes.filter((/** @type {any} */ b) => b.ok).at(-1) || {}).equipment_id;
      const overriddenParts = [];
      const roleValues = {};
      for (const box of cool.boxes.filter((/** @type {any} */ b) => b.ok)) {
        const max = get(box.equipment_id, 'discharge_air_volume_flow_rate_maximum') || box.target || 300;
        const cap = (starved && (box.equipment_id === starved || String(starved).includes(box.equipment_id) || String(starved).includes('03'))) ? max * 0.45 : max;
        const flow = Math.min(max, cap);
        const damper = cap < max * 0.9 ? 100 : 100 * (flow / max);
        set(box.equipment_id, 'discharge_air_volume_flow_rate_setpoint', max);
        set(box.equipment_id, 'discharge_air_volume_flow_rate', flow);
        set(box.equipment_id, 'damper_position_command', 100);
        set(box.equipment_id, 'damper_position', damper);
        roleValues[`${box.equipment_id}:discharge_air_volume_flow_rate`] = flow;
        roleValues[`${box.equipment_id}:discharge_air_volume_flow_rate_maximum`] = max;
        roleValues[`${box.equipment_id}:damper_position`] = damper;
        const part = current.layout.pointPart[pts.find((q) => q.equipment === box.equipment_id && q.role === 'damper_position_command')?.id] || box.equipment_id;
        overriddenParts.push(part);
      }
      current.values = values;
      const frame = T.liveFrame(current.unit, S.points, values);
      demoRun = {
        active: true, demo: true, systemId: current.unit.id, systemLabel: current.unit.label,
        label: 'VAV max cooling airflow', holdMin, started, endsAt, assess: cool, values, roleValues,
        overriddenParts, frame, report: null, outcome: null,
      };
      renderBanner();
      renderTestPanel();
      renderIdleNote();
      renderOverview();
      if (scene) scene.update(frame, marksNow());
    }

    function finishDemoRun(/** @type {string} */ outcome) {
      if (!demoRun) return;
      const snap = {
        values: demoRun.roleValues || {},
        staticPa: demoRun.frame && demoRun.frame.scene ? demoRun.frame.scene.staticPa : 0,
        fanSpeed: demoRun.frame && demoRun.frame.scene ? demoRun.frame.scene.fanSpeed : 0,
        fanOn: true,
      };
      const report = outcome === 'aborted' ? { ok: false, results: [], systemDeficiencies: [{ kind: 'aborted', message: 'Operator aborted; overrides released.' }] } : F.maxCooling.evaluate(demoRun.assess, snap);
      demoRun.active = false;
      demoRun.outcome = outcome === 'aborted' ? 'aborted' : (report.ok ? 'pass' : 'fail');
      demoRun.report = report;
      demoRun.overriddenParts = []; // released
      current.deficiencies = [];
      renderDeficiencies();
      renderBanner();
      renderTestPanel();
      renderIdleNote();
      renderOverview();
      const host = $('graphicRunResult');
      if (host) {
        D.fill(host, D.el('div', { class: `graphic-outcome ${demoRun.outcome}` },
          D.el('b', { text: String(demoRun.outcome).toUpperCase() }),
          D.el('span', { text: report.ok ? ' All testable boxes reached the hold target. Overrides released.' : ' Deficiencies were recorded and every override was released.' })));
      }
      if (scene) scene.update(frameNow(), marksNow());
      o.notify(demoRun.outcome === 'pass' ? 'Demo max-cooling test passed. Overrides released.' : `Demo max-cooling test ${demoRun.outcome}. Overrides released.`, demoRun.outcome !== 'pass');
    }

    async function abortRun(/** @type {boolean} */ all) {
      if (o.demo && demoRun && demoRun.active) {
        finishDemoRun('aborted');
        return;
      }
      try {
        const reply = await o.api.abort(all ? { all: true } : { system_id: selectedId });
        if (reply && reply.ok === false) o.notify(`Refused: ${reply.code || 'unknown'}`, true);
        else o.notify(all ? 'Abort all requested. Overrides are being released.' : 'Abort requested. Overrides are being released.');
      } catch (err) {
        o.notify(String(/** @type {any} */ (err).message || err), true);
      }
    }

    function tick() {
      if (!current || !scene) {
        if (demoRun && demoRun.active) renderBanner();
        return;
      }
      if (demoRun && demoRun.active) {
        if (Date.now() >= demoRun.endsAt) finishDemoRun('complete');
        else {
          renderBanner();
          scene.update(demoRun.frame, marksNow());
        }
        return;
      }
      scene.update(frameNow(), marksNow());
    }

    $('graphicRefresh').addEventListener('click', () => refresh(true));
    $('graphicUnit').addEventListener('change', () => { if (current) build(current.model); });

    return {
      async activate() {
        active = true;
        if (!booting) booting = boot().catch((err) => { booting = null; o.notify(`Graphic: ${err.message || err}`, true); });
        await booting;
        if (!active) return;
        if (!timer) timer = setInterval(tick, 250);
        if (!recheck && source) recheck = setInterval(() => refresh(false), source.recheckMs);
        if (scene) scene.resize();
      },
      deactivate() {
        active = false;
        clearInterval(timer); timer = null;
        clearInterval(recheck); recheck = null;
      },
      setStatus(/** @type {any} */ next) { status = next; renderBanner(); renderOverview(); renderIdleNote(); },
      abortAll: () => abortRun(true),
      /** Screenshot helper: start the demo max-cooling test and optionally wait until it has failed. */
      async debugRun(/** @type {{ until?: 'hold'|'end', systemId?: string }} */ opts) {
        await booting;
        if (opts && opts.systemId) {
          /** @type {HTMLSelectElement} */ ($('graphicUnit')).value = opts.systemId;
          selectedId = opts.systemId;
          if (current) await build(current.model);
        }
        startDemoRun();
        if (opts && opts.until === 'end' && demoRun) {
          demoRun.endsAt = Date.now() - 1;
          finishDemoRun('complete');
        }
        return demoRun;
      },
      async showSystem(/** @type {string} */ id) {
        await booting;
        /** @type {HTMLSelectElement} */ ($('graphicUnit')).value = id;
        selectedId = id;
        if (current) await build(current.model);
        return current;
      },
    };
  }

  root.NfftGraphicView = { mount };
})(globalThis);
