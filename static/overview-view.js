// Overview tab: a dashboard of equipment cards with live NF values, test readiness and run progress, and a live 2D
// schematic of the building (rooftop unit, duct, floors of VAV boxes, hot-water plant). Reads the NF model layer only;
// nothing here writes. SI by default; the units switch changes the display only. Browser global NfftOverviewView.
(function (root) {
  'use strict';

  const g = /** @type {any} */ (root);
  const UNITS_KEY = 'nfft-units';
  const POLL_MS = 20000;

  /**
   * @param {{ api: any, demo: boolean, notify: (t: string, bad?: boolean) => void, host: HTMLElement, runInfo: () => any }} o
   */
  function mount(o) {
    const d = g.NfftDom;
    const OV = g.NfftOverviewModel;
    /** @type {any} */
    let model = null;
    /** @type {any} */
    let timer = null;
    let on = false;
    let busy = false;
    let error = '';
    let loadedAt = 0;
    /** @type {'si'|'imperial'} */
    let units = 'si';
    try { units = root.localStorage.getItem(UNITS_KEY) === 'imperial' ? 'imperial' : 'si'; } catch { /* private mode */ }

    const fmt = (/** @type {any} */ r) => (r ? OV.format(r.q, r.value, units) : '—');

    async function load() {
      if (busy) return;
      busy = true;
      try {
        const records = await o.api.queryAll({ layer: 'model' });
        model = OV.summarize(records, { now: o.api.now() });
        error = '';
        loadedAt = Date.now();
      } catch (err) {
        error = String(/** @type {any} */ (err).message || err);
      } finally {
        busy = false;
      }
      render();
    }

    function unitSwitch() {
      return d.el('span', { class: 'seg flush' }, ...[['si', 'SI'], ['imperial', 'Imperial']].map(([k, label]) => d.el('button', {
        type: 'button', class: units === k ? 'on' : '', text: label,
        onclick: () => { units = /** @type {any} */ (k); try { root.localStorage.setItem(UNITS_KEY, k); } catch { /* */ } render(); },
      })));
    }

    function stat(/** @type {string} */ label, /** @type {string} */ value, /** @type {string} */ sub, /** @type {string} */ cls) {
      return d.el('div', { class: `ov-stat ${cls || ''}` }, d.el('div', { class: 'ov-stat-label', text: label }), d.el('div', { class: 'ov-stat-val', text: value }), d.el('div', { class: 'ov-stat-sub', text: sub }));
    }

    function readyPill(/** @type {any} */ card, /** @type {any} */ run) {
      if (run && run.equipment && run.equipment.includes(card.id)) return d.el('span', { class: 'pill ov-running', text: 'testing now' });
      if (!card.ready.test) return null;
      return card.ready.ok ? d.el('span', { class: 'pill ok', text: `${card.ready.test}: ready` })
        : d.el('span', { class: 'pill op-warn', title: card.ready.missing.join(', '), text: `${card.ready.test}: missing ${card.ready.missing.length}` });
    }

    function readingRows(/** @type {any} */ card) {
      return d.el('dl', { class: 'ov-readings' }, ...card.readings.flatMap((/** @type {any} */ r) => [
        d.el('dt', { text: r.label, title: r.point || '' }),
        d.el('dd', { class: r.simOnly ? 'sim-only' : '', title: r.simOnly ? 'simulator-only point (not on the real site)' : '', text: fmt(r) }),
      ]));
    }

    function bigCard(/** @type {any} */ card, /** @type {any} */ run) {
      return d.el('section', { class: `ov-card ov-${card.kind}${card.stale ? ' stale' : ''}` },
        d.el('header', { class: 'ov-card-head' },
          d.el('div', {}, d.el('div', { class: 'ov-card-title', text: card.label }), d.el('div', { class: 'ov-card-sub', text: `${card.points} points${card.simOnly ? ` · ${card.simOnly} sim only` : ''}${card.stale ? ' · values stale' : ''}` })),
          readyPill(card, run)),
        readingRows(card),
        card.ready.test && !card.ready.ok ? d.el('p', { class: 'ov-missing', text: `Missing: ${card.ready.missing.join(', ')}` }) : null);
    }

    function vavTile(/** @type {any} */ card, /** @type {any} */ run) {
      const k = OV.byKey(card);
      const state = OV.zoneState(card);
      const flowPct = k.flow && k.flowMax && k.flowMax.value ? Math.round((k.flow.value / k.flowMax.value) * 100) : null;
      const bar = d.el('i');
      if (flowPct !== null) bar.style.width = `${Math.max(0, Math.min(100, flowPct))}%`;
      const testing = run && run.equipment && run.equipment.includes(card.id);
      return d.el('div', { class: `ov-vav z-${state}${testing ? ' testing' : ''}${card.stale ? ' stale' : ''}`, title: `${card.label}\n${card.readings.map((/** @type {any} */ r) => `${r.label}: ${fmt(r)}`).join('\n')}${card.ready.ok ? '' : `\nMissing for ${card.ready.test}: ${card.ready.missing.join(', ')}`}` },
        d.el('div', { class: 'ov-vav-head' }, d.el('b', { text: card.id.replace(/^nfft-sim-/, '').toUpperCase() }), card.ready.ok ? d.el('span', { class: 'dot ok', title: 'VAV max cooling ready' }) : d.el('span', { class: 'dot warn', title: 'not testable' })),
        d.el('div', { class: 'ov-vav-temp', text: fmt(k.zat) }),
        d.el('div', { class: 'ov-vav-sub', text: `sp ${fmt(k.zatSp)}` }),
        d.el('div', { class: 'ov-vav-flow' }, d.el('span', { text: fmt(k.flow) }), d.el('span', { class: 'muted', text: flowPct === null ? '' : `${flowPct}% of max` })),
        d.el('div', { class: 'ov-flowbar' }, bar),
        d.el('div', { class: 'ov-vav-sub', text: `damper ${fmt(k.damper)} · reheat ${fmt(k.reheat)}` }));
    }

    /** Live 2D schematic: RTU on the roof, supply duct down a riser to each floor, VAV boxes coloured by zone state. */
    function schematic(/** @type {any} */ m, /** @type {any} */ run) {
      const floors = Object.keys(m.floors).sort().reverse();
      const perRow = Math.max(1, ...floors.map((f) => m.floors[f].length));
      const cellW = 46;
      const left = 150;
      const W = Math.max(720, left + perRow * cellW + 40);
      const floorH = 86;
      const top = 92;
      const H = top + floors.length * floorH + 70;
      const s = d.svg;
      const ahu = m.ahus[0];
      const ak = ahu ? OV.byKey(ahu) : {};
      const fanOn = ahu ? (ak.fanStatus ? ak.fanStatus.value >= 0.5 : (ak.fan ? ak.fan.value > 1 : false)) : false;
      const flowCls = `ov-duct${fanOn ? ' flowing' : ''}`;
      /** @type {any[]} */
      const kids = [];
      kids.push(s('rect', { x: 8, y: 8, width: W - 16, height: 64, rx: 10, class: 'ov-roof' }));
      kids.push(s('text', { x: 20, y: 28, class: 'ov-svg-label', text: 'Roof' }));
      if (ahu) {
        kids.push(s('rect', { x: 40, y: 34, width: 190, height: 32, rx: 6, class: `ov-rtu${run && run.equipment && run.equipment.includes(ahu.id) ? ' testing' : ''}` }));
        kids.push(s('text', { x: 52, y: 55, class: 'ov-svg-strong', text: `${ahu.label}  ${fmt(ak.sat)}` }));
        kids.push(s('circle', { cx: 214, cy: 50, r: 10, class: `ov-fan${fanOn ? ' spinning' : ''}` }));
        kids.push(s('text', { x: 250, y: 46, class: 'ov-svg-label', text: `static ${fmt(ak.static)} (sp ${fmt(ak.staticSp)})` }));
        kids.push(s('text', { x: 250, y: 62, class: 'ov-svg-label', text: `fan ${fmt(ak.fan)} · OA ${fmt(ak.oat)} · OA damper ${fmt(ak.oaDamper)}` }));
      }
      const riserX = 110;
      kids.push(s('path', { d: `M ${riserX} 66 V ${top + (floors.length - 1) * floorH + 40}`, class: flowCls }));
      floors.forEach((f, i) => {
        const y = top + i * floorH;
        kids.push(s('rect', { x: 8, y, width: W - 16, height: floorH - 10, rx: 8, class: 'ov-floor' }));
        kids.push(s('text', { x: 20, y: y + 20, class: 'ov-svg-strong', text: `Floor ${f}` }));
        const boxes = m.floors[f];
        const ductY = y + 34;
        kids.push(s('path', { d: `M ${riserX} ${ductY} H ${left + boxes.length * cellW}`, class: flowCls }));
        boxes.forEach((/** @type {any} */ b, /** @type {number} */ j) => {
          const x = left + j * cellW;
          const k = OV.byKey(b);
          const st = OV.zoneState(b);
          const testing = run && run.equipment && run.equipment.includes(b.id);
          kids.push(s('rect', { x: x + 4, y: ductY + 8, width: cellW - 10, height: 30, rx: 4, class: `ov-svg-vav z-${st}${testing ? ' testing' : ''}` },
            s('title', { text: `${b.label}: zone ${fmt(k.zat)}, flow ${fmt(k.flow)}` })));
          kids.push(s('text', { x: x + cellW / 2 - 1, y: ductY + 22, class: 'ov-svg-mini', 'text-anchor': 'middle', text: b.id.replace(/^nfft-sim-vav-/, '').replace(/^vav-/, '') }));
          kids.push(s('text', { x: x + cellW / 2 - 1, y: ductY + 34, class: 'ov-svg-mini', 'text-anchor': 'middle', text: k.zat && k.zat.value !== null ? (units === 'imperial' ? (k.zat.value * 1.8 + 32).toFixed(0) : k.zat.value.toFixed(1)) : '—' }));
        });
      });
      const plant = m.plants[0];
      if (plant) {
        const pk = OV.byKey(plant);
        const y = top + floors.length * floorH + 4;
        kids.push(s('rect', { x: 8, y, width: W - 16, height: 52, rx: 8, class: 'ov-plant' }));
        kids.push(s('text', { x: 20, y: y + 22, class: 'ov-svg-strong', text: plant.label }));
        kids.push(s('text', { x: 20, y: y + 40, class: 'ov-svg-label', text: `HWS ${fmt(pk.hws)} · HWR ${fmt(pk.hwr)} · DP ${fmt(pk.dp)} · pump ${fmt(pk.pump)} · boiler ${fmt(pk.boiler)} · serves VAV reheat` }));
      }
      return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ov-schematic', role: 'img', 'aria-label': 'Building schematic with live values' }, ...kids);
    }

    function render() {
      const host = o.host;
      if (!host) return;
      const run = o.runInfo ? o.runInfo() : null;
      if (!model) {
        d.fill(host, d.el('div', { class: 'panel' }, d.el('p', { class: 'muted', text: error ? `Cannot read the NF model: ${error}` : 'Reading the NF model…' })));
        return;
      }
      const m = model;
      const progress = run && run.active ? d.el('div', { class: 'ov-progress' },
        d.el('div', { class: 'ov-progress-head' }, d.el('b', { text: `${run.label} · step ${run.step} of ${run.steps}` }), d.el('span', { class: 'muted', text: run.detail || '' })),
        (() => { const bar = d.el('i'); bar.style.width = `${Math.round(run.fraction * 100)}%`; return d.el('div', { class: 'ov-flowbar big' }, bar); })()) : null;
      const zones = m.vavs.map((/** @type {any} */ v) => OV.zoneState(v));
      const warm = zones.filter((/** @type {string} */ z) => z === 'warm').length;
      const cold = zones.filter((/** @type {string} */ z) => z === 'cold').length;
      d.fill(host,
        d.el('div', { class: 'ov-top' },
          d.el('div', {}, d.el('h2', { class: 'ov-site', text: m.site || 'Site' }), d.el('div', { class: 'muted', text: `${m.counts.ahus} air handler${m.counts.ahus === 1 ? '' : 's'} · ${m.counts.vavs} VAV boxes · ${m.plants.length} plant${m.plants.length === 1 ? '' : 's'} · read only, updated ${loadedAt ? new Date(loadedAt).toLocaleTimeString() : '—'}` })),
          d.el('div', { class: 'spacer' }), unitSwitch()),
        d.el('div', { class: 'ov-stats' },
          stat('Run state', run ? run.label : 'unknown', run ? run.sub : '', run && run.active ? 'live' : ''),
          stat('Next scheduled run', run && run.next ? run.next : '—', run && run.nextSub ? run.nextSub : 'trigger off'),
          stat('Ready to test', `${m.counts.ready} of ${m.counts.equipment}`, m.counts.notReady ? `${m.counts.notReady} missing points` : 'every system has the points it needs', m.counts.notReady ? 'warn' : 'good'),
          stat('Zones', `${m.counts.vavs - warm - cold} in band`, `${warm} warm · ${cold} cold (±1 K of setpoint)`, warm + cold ? 'warn' : 'good'),
          stat('Active NF commands', run ? String(run.commands) : '—', run && run.commands ? 'each expires on its own' : 'nothing overridden', run && run.commands ? 'live' : '')),
        progress,
        d.el('div', { class: 'panel' }, d.el('h2', {}, 'Building schematic', d.el('span', { class: 'hint', text: 'live NF values · blue = cool, green = in band, orange = warm · flow animates while the fan runs' })), schematic(m, run)),
        d.el('div', { class: 'ov-row' }, ...m.ahus.map((/** @type {any} */ c) => bigCard(c, run)), ...m.plants.map((/** @type {any} */ c) => bigCard(c, run))),
        ...Object.keys(m.floors).sort().map((f) => d.el('div', { class: 'panel' },
          d.el('h2', {}, `Floor ${f}`, d.el('span', { class: 'hint', text: `${m.floors[f].length} VAV boxes with hot-water reheat · hover a box for every reading` })),
          d.el('div', { class: 'ov-vavs' }, ...m.floors[f].map((/** @type {any} */ v) => vavTile(v, run))))),
        m.other.length ? d.el('div', { class: 'ov-row' }, ...m.other.map((/** @type {any} */ c) => bigCard(c, run))) : null);
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = on ? setTimeout(async () => { await load(); schedule(); }, POLL_MS) : null;
    }

    return {
      activate() {
        if (on) { render(); return; }
        on = true;
        load().then(schedule);
      },
      deactivate() { on = false; if (timer) clearTimeout(timer); timer = null; },
      render,
      refresh: load,
      state: () => model,
    };
  }

  g.NfftOverviewView = { mount };
})(globalThis);
