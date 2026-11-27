// Digital twin tab: the 3D commissioning view, its sliders and the functional-test playback, all generated from
// the 223P model derived from NF tags (NfftModelSource). The sim is a sandbox: nothing on this tab writes to NF.
// Live values are read-only. Browser global NfftTwinView.
(function (root) {
  'use strict';

  const g = /** @type {any} */ (root);
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const STATIC_LIMIT_PA = 750;
  const idOf = (/** @type {any} */ r) => (r.attrs || {}).id || r.name;

  /** Classic script once (CSP: same origin, no inline). */
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

  /** Oxigraph's web build, the way the Open-FDD page loads it. */
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
    const T = g.NfftTwin;
    const S = g.NfftS223;
    /** @type {any} */ let source = null;
    /** @type {any} */ let current = null; // { model, unit, layout, sim, values }
    /** @type {any} */ let scene = null;
    /** @type {any} */ let run = null; // recorded test
    let frameIndex = 0;
    let playing = false;
    let speed = 8;
    /** @type {any} */ let timer = null;
    /** @type {any} */ let recheck = null;
    let active = false;
    let booting = /** @type {Promise<any>|null} */ (null);
    /** @type {Record<string, string>} */ let faults = {};

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
        D.fill($('twinSource'), D.el('span', { class: 'pill bad', text: 'model unavailable' }), ' ', String(/** @type {any} */ (err).message || err));
        return;
      }
      renderSource(got);
      if (got.rebuilt || !current) await build(got.model);
    }

    function renderSource(/** @type {any} */ got) {
      const m = got.model;
      const label = got.source === 'open-fdd' ? 'Open-FDD graph (shared)' : 'Built-in graph from NF tags';
      D.fill($('twinSource'),
        D.el('span', { class: `pill ${got.source === 'open-fdd' ? 'ok' : ''}`, text: label }), ' ',
        D.el('span', { class: 'muted', text: `snapshot ${got.snapshot.slice(0, 10)} · ${m.bindings.length} points bound · ${m.report.unbound.length} unbound · ${m.report.ambiguous.length + m.report.duplicates.length} ambiguous · checked ${new Date(got.checkedAt).toLocaleTimeString()}` }),
        got.note ? D.el('div', { class: 'hint', text: got.note }) : null,
        m.warnings.length ? D.el('div', { class: 'hint warn', text: m.warnings.join(' · ') }) : null);
      const pick = /** @type {HTMLSelectElement} */ ($('twinUnit'));
      const prev = pick.value;
      D.fill(pick, m.ahus.map((/** @type {any} */ a) => D.el('option', { value: a.id, text: `${a.label} · ${a.terminals.length} terminals` })));
      if (prev && m.ahus.some((/** @type {any} */ a) => a.id === prev)) pick.value = prev;
    }

    async function liveValues(/** @type {any} */ unit) {
      if (o.demo && o.api.demoRecords) {
        const r = await o.api.demoRecords();
        return Object.fromEntries(r.points.map((/** @type {any} */ p) => [p.uuid, p.latestValue]));
      }
      try {
        const recs = await g.NfftModelSource.loadRecords(o.api.queryAll, idOf);
        const want = new Set(S.points(unit).map((/** @type {any} */ p) => p.id));
        return Object.fromEntries(recs.points.filter((/** @type {any} */ p) => want.has(p.uuid)).map((/** @type {any} */ p) => [p.uuid, p.latestValue]));
      } catch {
        return {};
      }
    }

    async function build(/** @type {any} */ model) {
      const pick = /** @type {HTMLSelectElement} */ ($('twinUnit'));
      const unit = model.ahus.find((/** @type {any} */ a) => a.id === pick.value) || model.ahus[0];
      if (!unit) {
        D.fill($('twinStage'), D.el('div', { class: 'empty', text: 'No air handler in the model. Tag an ahu equipment and its points in NF.' }));
        return;
      }
      const values = await liveValues(unit);
      faults = {};
      for (const s of model.scenarios || []) faults[s.part] = s.spec;
      const layout = T.layout(unit, S.points);
      current = { model, unit, layout, values };
      newSim();
      run = null;
      renderControls();
      renderFaults();
      renderLive();
      await renderScene();
      renderRun();
    }

    function newSim() {
      current.sim = T.createSim(current.unit, { points: S.points, faults, values: current.values });
      current.sim.settle();
    }

    async function renderScene() {
      if (scene) scene.dispose();
      const mod = await import(/** @type {string} */ ('./twin-scene.js'));
      scene = mod.createTwinScene($('twinStage'), current.layout, { pressureColor: T.pressureColor, staticLimitPa: STATIC_LIMIT_PA, preserveDrawingBuffer: true });
      scene.update(current.sim.read(), {});
    }

    // ---- manual simulation ----
    function renderControls() {
      const sim = current.sim;
      const rows = sim.inputs.map((/** @type {any} */ p) => {
        const out = D.el('output', { class: 'mono', text: fmtInput(p, sim.get(p.id)) });
        const input = D.el('input', { type: 'range', min: String(p.min), max: String(p.max), step: String(p.step), value: String(sim.get(p.id)), 'aria-label': p.label });
        input.addEventListener('input', () => {
          if (run) leaveReplay();
          sim.set(p.id, Number(/** @type {HTMLInputElement} */ (input).value));
          out.textContent = fmtInput(p, Number(/** @type {HTMLInputElement} */ (input).value));
        });
        return D.el('label', { class: 'twin-slider' }, D.el('span', { class: 'name', text: p.label }), D.el('span', { class: 'role mono', text: p.role }), input, out);
      });
      D.fill($('twinControls'), rows);
    }
    const fmtInput = (/** @type {any} */ p, /** @type {number} */ v) => (p.max === 1 ? (v >= 0.5 ? 'on' : 'off') : `${Math.round(v)}%`);

    function renderFaults() {
      const dampers = current.sim.binding.terminals.filter((/** @type {any} */ t) => t.damperPart);
      const sel = D.el('select', { id: 'twinFaultPart', 'aria-label': 'Faulted damper' },
        D.el('option', { value: '', text: 'No fault' }),
        dampers.map((/** @type {any} */ t) => D.el('option', { value: t.damperPart, text: `${t.label} damper` })));
      const kind = D.el('select', { id: 'twinFaultKind', 'aria-label': 'Fault kind' },
        D.el('option', { value: 'stuck', text: 'actuator binds at' }),
        D.el('option', { value: 'linkage', text: 'linkage slipped, blade at' }),
        D.el('option', { value: 'feedback_scale', text: 'feedback scaled by' }));
      const val = D.el('input', { id: 'twinFaultValue', type: 'number', min: '0', max: '100', step: '1', value: '38', 'aria-label': 'Fault value' });
      const [part, spec] = Object.entries(faults)[0] || ['', 'stuck:38'];
      /** @type {HTMLSelectElement} */ (sel).value = part;
      const f = T.parseFault(spec);
      if (f) { /** @type {HTMLSelectElement} */ (kind).value = f.kind; /** @type {HTMLInputElement} */ (val).value = String(f.value); }
      const apply = D.el('button', { class: 'btn', type: 'button', text: 'Apply to sim' });
      apply.addEventListener('click', () => {
        const p = /** @type {HTMLSelectElement} */ (sel).value;
        faults = p ? { [p]: `${/** @type {HTMLSelectElement} */ (kind).value}:${/** @type {HTMLInputElement} */ (val).value}` } : {};
        leaveReplay();
        newSim();
        renderControls();
      });
      D.fill($('twinFaults'), D.el('span', { class: 'hint', text: 'Simulated fault' }), sel, kind, val, apply);
    }

    function renderLive() {
      const pts = S.points(current.unit);
      const rows = pts.map((/** @type {any} */ p) => D.el('tr', {},
        D.el('td', { text: p.part_label || p.part }), D.el('td', { text: p.label }), D.el('td', { class: 'mono', text: p.role || 'unbound' }),
        D.el('td', { class: 'mono', text: current.values[p.id] === undefined || current.values[p.id] === null ? '—' : String(current.values[p.id]) }),
        D.el('td', { text: p.actuatable ? 'writable role' : 'read' })));
      D.fill($('twinPoints'), D.el('table', { class: 'bac' },
        D.el('thead', {}, D.el('tr', {}, ['Equipment', 'Point (NF)', 'Open-FDD role', o.demo ? 'Value (demo)' : 'NF value (read-only)', 'Kind'].map((h) => D.el('th', { text: h })))),
        D.el('tbody', {}, rows)));
    }

    function tick() {
      if (!current || !scene) return;
      if (run) {
        if (playing) {
          frameIndex = Math.min(run.frames.length - 1, frameIndex + speed);
          if (frameIndex >= run.frames.length - 1) playing = false;
          showFrame();
        }
        return;
      }
      current.sim.step(1);
      scene.update(current.sim.read(), {});
    }

    // ---- functional test playback ----
    function runTest() {
      leaveReplay();
      newSim();
      const plan = T.strokePlan(current.sim, { staticLimitPa: STATIC_LIMIT_PA });
      run = T.runStroke(current.sim, plan);
      run.plan = plan;
      frameIndex = 0;
      playing = true;
      renderRun();
      showFrame();
    }

    function leaveReplay() {
      if (!run) return;
      run = null;
      playing = false;
      newSim();
      renderControls();
      renderRun();
    }

    /** Part ids the current frame has overridden (amber) and parts already found faulty (red). */
    function marks(/** @type {any} */ f) {
      const overridden = f.overrides.map((/** @type {string} */ id) => current.layout.pointPart[id]).filter(Boolean);
      const faulted = [];
      for (const r of run.results.filter((/** @type {any} */ x) => !x.pass)) {
        const doneAt = run.frames.findIndex((/** @type {any} */ x) => x.step && x.step.step_id === r.step_id && x.phase === 'CAPTURE');
        const t = current.sim.binding.terminals.find((/** @type {any} */ x) => x.id === r.terminal);
        if (doneAt >= 0 && frameIndex >= doneAt + run.plan.captureS - 1 && t) faulted.push(t.damperPart);
      }
      return { overridden, faulted };
    }

    function showFrame() {
      if (!run) return;
      const f = run.frames[frameIndex];
      scene.update(f, marks(f));
      const range = /** @type {HTMLInputElement} */ ($('twinScrub'));
      range.max = String(run.frames.length - 1);
      range.value = String(frameIndex);
      const term = f.step ? current.sim.binding.terminals.find((/** @type {any} */ t) => t.id === f.step.terminal) : null;
      $('twinPhase').textContent = `t+${f.t}s · ${f.label}${term ? ` → ${f.step.target}%` : ''}`;
      $('twinPhase').className = `twin-phase ${f.phase.toLowerCase()}`;
      $('twinPlay').textContent = playing ? 'Pause' : 'Play';
      chartFrame(f);
    }

    function chartFrame(/** @type {any} */ f) {
      const terms = current.sim.binding.terminals;
      const focus = f.step ? f.step.terminal : (run.results.find((/** @type {any} */ r) => !r.pass) || run.results[0] || { terminal: terms[0].id }).terminal;
      const ti = terms.findIndex((/** @type {any} */ t) => t.id === focus);
      const t = terms[ti];
      const xs = run.frames.map((/** @type {any} */ x) => x.t);
      D.chart($('twinChart'), {
        animation: false,
        grid: { left: 48, right: 56, top: 34, bottom: 28 },
        legend: { top: 0 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: xs, name: 's' },
        yAxis: [{ type: 'value', name: '%', min: 0, max: 100 }, { type: 'value', name: 'L/s', min: 0 }],
        series: [
          { name: `${t.label} command`, type: 'line', showSymbol: false, step: 'end', data: run.frames.map((/** @type {any} */ x) => x.scene.terminals[ti].command) },
          { name: 'feedback', type: 'line', showSymbol: false, data: run.frames.map((/** @type {any} */ x) => x.scene.terminals[ti].feedback) },
          { name: 'airflow', type: 'line', yAxisIndex: 1, showSymbol: false, data: run.frames.map((/** @type {any} */ x) => x.scene.terminals[ti].flowLps),
            markLine: { symbol: 'none', silent: true, data: [{ xAxis: String(f.t) }] } },
        ],
      });
    }

    function renderRun() {
      const box = $('twinRun');
      if (!run) {
        D.fill(box, D.el('div', { class: 'hint', text: 'Run the stroke test to record a replay. Steps are generated from the model: every terminal with a damper command and damper feedback, stepped to 0%, 100% and 50%.' }));
        $('twinScrubRow').hidden = true;
        return;
      }
      $('twinScrubRow').hidden = false;
      const banner = D.el('div', { class: `twin-outcome ${run.outcome}` },
        D.el('b', { text: run.outcome.toUpperCase() }),
        D.el('span', { text: ` ${run.results.filter((/** @type {any} */ r) => r.pass).length}/${run.results.length} steps passed · ${run.frames.length} s recorded · overrides released: ${run.release.ok ? 'yes' : 'NO'} · NF writes: ${run.nf_writes}` }),
        run.stop_reason ? D.el('span', { class: 'hint', text: ` · stopped: ${run.stop_reason}` }) : null);
      const rows = run.results.map((/** @type {any} */ r) => D.el('tr', { class: r.pass ? '' : 'bad-row' },
        D.el('td', { text: r.label }), D.el('td', { class: 'mono', text: `${r.target}%` }), D.el('td', { class: 'mono', text: `${r.feedback}%` }),
        D.el('td', { class: 'mono', text: (r.flow ?? null) === null ? '—' : `${r.flow} / ${r.expected_flow} L/s` }), D.el('td', { class: 'mono', text: `${r.settled_s}s${r.timed_out ? ' (timeout)' : ''}` }),
        D.el('td', { text: r.pass ? 'PASS' : `FAIL · ${r.cause}` }), D.el('td', { class: 'explain', text: r.explanation.join(' ') })));
      D.fill(box, banner, D.el('table', { class: 'bac mt6' },
        D.el('thead', {}, D.el('tr', {}, ['Terminal', 'Command', 'Feedback', 'Airflow / expected', 'Settled', 'Result', 'Deterministic diagnosis'].map((h) => D.el('th', { text: h })))),
        D.el('tbody', {}, rows)),
      run.skipped.length ? D.el('div', { class: 'hint mt6', text: `Skipped: ${run.skipped.map((/** @type {any} */ s) => `${s.label} (${s.reason})`).join('; ')}` }) : null);
    }

    $('twinRunBtn').addEventListener('click', runTest);
    $('twinLiveBtn').addEventListener('click', leaveReplay);
    $('twinRefresh').addEventListener('click', () => refresh(true));
    $('twinUnit').addEventListener('change', () => { if (current) build(current.model); });
    $('twinPlay').addEventListener('click', () => { if (!run) return; if (frameIndex >= run.frames.length - 1) frameIndex = 0; playing = !playing; showFrame(); });
    $('twinScrub').addEventListener('input', () => { playing = false; frameIndex = Number(/** @type {HTMLInputElement} */ ($('twinScrub')).value); showFrame(); });
    $('twinBack').addEventListener('click', () => { if (!run) return; playing = false; frameIndex = Math.max(0, frameIndex - 10); showFrame(); });
    $('twinFwd').addEventListener('click', () => { if (!run) return; playing = false; frameIndex = Math.min(run.frames.length - 1, frameIndex + 10); showFrame(); });
    $('twinSpeed').addEventListener('change', () => { speed = Number(/** @type {HTMLSelectElement} */ ($('twinSpeed')).value); });

    return {
      async activate() {
        active = true;
        if (!booting) booting = boot().catch((err) => { booting = null; o.notify(`Digital twin: ${err.message || err}`, true); });
        await booting;
        if (!active) return;
        if (!timer) timer = setInterval(tick, 125);
        // Re-check the model source while the tab is open: picks up Open-FDD being installed, removed or upgraded.
        if (!recheck && source) recheck = setInterval(() => refresh(false), source.recheckMs);
        if (scene) scene.resize();
      },
      deactivate() {
        active = false;
        clearInterval(timer); timer = null;
        clearInterval(recheck); recheck = null;
      },
      /** For screenshots and tests: run the test and jump to a frame. */
      async replayAt(/** @type {number} */ fraction) {
        await booting;
        runTest();
        playing = false;
        frameIndex = Math.round((run.frames.length - 1) * fraction);
        showFrame();
        return run;
      },
    };
  }

  root.NfftTwinView = { mount };
})(globalThis);
