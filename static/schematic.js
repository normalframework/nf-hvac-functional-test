/**
 * Flat 2D schematics, shared by the Functional test graphic and the Operating point panels.
 * Every component sits in a fixed slot, labels are wrapped or truncated to the slot and carry the full name as a
 * tooltip, and live values are badges at fixed places, so nothing overlaps. Pure layout helpers are CommonJS-exportable
 * for tests; drawing uses NfftDom (SVG, CSS classes only, no inline styles). Browser global NfftSchematic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else /** @type {any} */ (root).NfftSchematic = factory(/** @type {any} */ (root));
})(typeof self !== 'undefined' ? self : this, function (/** @type {any} */ g) {
  'use strict';

  const ELLIPSIS = '…';
  /** Average glyph width in viewBox units for the 10.5 px label font; slot widths are sized from it. */
  const CHAR_W = 5.6;

  // ---- pure layout helpers ----

  /** @param {any} text @param {number} max @returns {{ text: string, full: string, truncated: boolean }} */
  function truncate(text, max) {
    const full = String(text === null || text === undefined ? '' : text);
    if (full.length <= max) return { text: full, full, truncated: false };
    return { text: `${full.slice(0, Math.max(1, max - 1))}${ELLIPSIS}`, full, truncated: true };
  }

  /**
   * Wrap a label into at most maxLines lines of maxChars; the last line is truncated. Breaks at spaces, dashes and
   * underscores when it can, else inside a long word.
   * @param {any} text @param {number} maxChars @param {number} [maxLines]
   * @returns {string[]}
   */
  function wrapLabel(text, maxChars, maxLines = 2) {
    const words = String(text === null || text === undefined ? '' : text).split(/(?<=[\s_-])/).map((w) => w.replace(/\s+$/, ' ')).filter((w) => w.length);
    /** @type {string[]} */
    const lines = [];
    let cur = '';
    for (let w of words) {
      while (w.length > maxChars) {
        if (cur) { lines.push(cur.trimEnd()); cur = ''; }
        lines.push(w.slice(0, maxChars));
        w = w.slice(maxChars);
      }
      if ((cur + w).trimEnd().length > maxChars) { lines.push(cur.trimEnd()); cur = w; } else cur += w;
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    const out = lines.filter(Boolean);
    if (out.length <= maxLines) return out;
    const kept = out.slice(0, maxLines);
    const rest = out.slice(maxLines - 1).join(' ');
    kept[maxLines - 1] = truncate(rest, maxChars).text;
    return kept;
  }

  /** x of the i-th of n slots of fixed pitch, left edge at x0. */
  const slotX = (/** @type {number} */ x0, /** @type {number} */ pitch, /** @type {number} */ i) => x0 + i * pitch;

  /** Grid cell for index i: perRow columns, then new rows. */
  function gridCell(/** @type {number} */ i, /** @type {number} */ perRow) {
    return { col: i % perRow, row: Math.floor(i / perRow) };
  }

  const fmt = (/** @type {any} */ v, /** @type {number} */ digits = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(digits));

  const GEO = { partW: 100, partH: 58, partPitchX: 124, lanePitch: 76, termW: 104, termH: 102, termPitchX: 120, termPitchY: 138, plantW: 104, plantH: 54, plantPitchX: 120, perRow: 6, margin: 30 };

  /**
   * 2D layout from NfftGraphic.layout(): fixed slots for plants (top), AHU parts in air-path order (columns by layer,
   * lanes stacked), the readout strip, and terminals in a grid of buses below. No two slots share a cell.
   * @param {any} layout
   */
  function layout2d(layout) {
    const m = GEO.margin;
    const els = layout.elements || [];
    const onPath = els.filter((/** @type {any} */ e) => e.scope === 'ahu' && !e.host);
    const hosted = els.filter((/** @type {any} */ e) => e.scope === 'ahu' && e.host);
    const plants = els.filter((/** @type {any} */ e) => e.scope === 'plant');
    const others = els.filter((/** @type {any} */ e) => e.scope === 'other');
    const hotFirst = (/** @type {any} */ a, /** @type {any} */ b) => (/boiler|hot|heat/i.test(b.label + b.kind) ? 1 : 0) - (/boiler|hot|heat/i.test(a.label + a.kind) ? 1 : 0);
    const plantOrder = [...plants].sort(hotFirst);
    const topRow = [...plantOrder, ...others];
    const hasPlants = topRow.length > 0;
    const plantY = m;
    const busHw = plantY + GEO.plantH + 18;
    const busChw = busHw + 14;
    const casingTop = hasPlants ? busChw + 62 : m + 34;

    const cols = [...new Set(onPath.map((/** @type {any} */ e) => Math.round(e.pos[0] * 100)))].sort((a, b) => a - b);
    const maxLanes = Math.max(1, ...cols.map((c) => onPath.filter((/** @type {any} */ e) => Math.round(e.pos[0] * 100) === c).length));
    const laneH = GEO.lanePitch;
    const casingX = m;
    const partsX0 = casingX + 16;
    const partsY0 = casingTop + 30;
    const casingW = 16 + cols.length * GEO.partPitchX + 6;
    const casingH = 30 + maxLanes * laneH + 6;
    /** @type {Record<string, any>} */
    const slots = {};
    for (const [ci, c] of cols.entries()) {
      const col = onPath.filter((/** @type {any} */ e) => Math.round(e.pos[0] * 100) === c).sort((a, b) => a.pos[2] - b.pos[2]);
      const offset = ((maxLanes - col.length) * laneH) / 2;
      col.forEach((/** @type {any} */ e, /** @type {number} */ li) => {
        slots[e.id] = { id: e.id, kind: e.kind, label: e.label, x: slotX(partsX0, GEO.partPitchX, ci), y: partsY0 + offset + li * laneH, w: GEO.partW, h: GEO.partH, scope: 'ahu', command: e.command };
      });
    }
    // Valves and sensors ride on their host, along its top edge.
    /** @type {Record<string, number>} */
    const perHost = {};
    for (const e of hosted) {
      const host = slots[e.host];
      if (!host) continue;
      const n = perHost[e.host] || 0;
      perHost[e.host] = n + 1;
      slots[e.id] = { id: e.id, kind: e.kind, label: e.label, x: host.x + host.w / 2 + n * 26 - 4, y: casingTop - 26, w: 18, h: 16, scope: 'ahu', command: e.command, host: e.host };
    }
    topRow.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
      slots[e.id] = { id: e.id, kind: e.kind, label: e.label, x: slotX(m, GEO.plantPitchX, i), y: plantY, w: GEO.plantW, h: GEO.plantH, scope: e.scope, command: e.command };
    });
    const casing = { x: casingX, y: casingTop, w: casingW, h: casingH, label: (layout.casing && layout.casing.label) || '' };
    const airY = casingTop + 30 + (maxLanes * laneH) / 2 - 10;

    const readY = casing.y + casing.h + 12;
    const nTerm = (layout.terminals || []).length;
    const perRow = Math.min(GEO.perRow, Math.max(1, nTerm));
    const rows = Math.max(1, Math.ceil(nTerm / perRow));
    const gridX = m + 6;
    const gridTop = readY + 24 + 46;
    const gridRight = gridX + perRow * GEO.termPitchX;
    const riserX = Math.max(casing.x + casing.w, gridRight) + 18;
    const terminals = (layout.terminals || []).map((/** @type {any} */ t, /** @type {number} */ i) => {
      const { col, row } = gridCell(i, perRow);
      return { id: t.id, index: t.index, label: t.label, zone: t.zone, damper: t.damper, reheat: t.reheat, valve: t.valve, x: slotX(gridX, GEO.termPitchX, col), y: gridTop + row * GEO.termPitchY, w: GEO.termW, h: GEO.termH, row };
    });
    const buses = Array.from({ length: nTerm ? rows : 0 }, (_, r) => ({ y: gridTop + r * GEO.termPitchY - 14, x1: gridX, x2: riserX }));
    const width = Math.max(riserX + m, topRow.length ? m + topRow.length * GEO.plantPitchX + m : 0, 760);
    const height = nTerm ? gridTop + rows * GEO.termPitchY - (GEO.termPitchY - GEO.termH) + m : readY + 60;
    const reads = Array.from({ length: 5 }, (_, i) => ({ x: casing.x + i * 124, y: readY, w: 116, h: 22 }));
    return { width, height, casing, airY, slots, topRow: topRow.map((e) => e.id), terminals, buses, riserX, reads, readY, busHw, busChw, plantBottom: plantY + GEO.plantH, cols: cols.length, rows };
  }

  /** Where a pipe runs: plant bottom centre, its medium bus, then down to the coil's top edge. */
  function pipePath(/** @type {any} */ lay, /** @type {any} */ plantId, /** @type {any} */ coilId, /** @type {string} */ medium) {
    const p = lay.slots[plantId];
    const c = lay.slots[coilId];
    if (!p || !c) return null;
    const bus = medium === 'hot_water' ? lay.busHw : lay.busChw;
    const px = p.x + p.w / 2 + (medium === 'hot_water' ? -6 : 6);
    const cx = c.x + c.w / 2 + (medium === 'hot_water' ? -6 : 6);
    return [[px, lay.plantBottom], [px, bus], [cx, bus], [cx, c.y]];
  }

  // ---- drawing helpers (NfftDom) ----

  const dom = () => /** @type {any} */ (g && g.NfftDom);

  /** Text with a tooltip carrying the full string; truncated to max characters. */
  function text(/** @type {number} */ x, /** @type {number} */ y, /** @type {any} */ value, /** @type {{ max?: number, cls?: string, anchor?: string, tip?: string }} */ o = {}) {
    const d = dom();
    const t = truncate(value, o.max || 24);
    const node = d.svg('text', { x, y, class: o.cls || 'sg-t', 'text-anchor': o.anchor || 'middle' }, t.text);
    const tip = o.tip || (t.truncated ? t.full : '');
    if (tip) node.appendChild(d.svg('title', {}, tip));
    return node;
  }

  /** A label wrapped into fixed lines at a slot; the tooltip has the whole name. */
  function label(/** @type {number} */ x, /** @type {number} */ y, /** @type {any} */ value, /** @type {number} */ maxChars, /** @type {{ cls?: string, anchor?: string, lines?: number, step?: number, tip?: string }} */ o = {}) {
    const d = dom();
    const lines = wrapLabel(value, maxChars, o.lines || 2);
    const g1 = d.svg('g', {}, d.svg('title', {}, o.tip || String(value)));
    lines.forEach((ln, i) => g1.appendChild(d.svg('text', { x, y: y + i * (o.step || 12), class: o.cls || 'sg-t sg-name', 'text-anchor': o.anchor || 'start' }, ln)));
    return g1;
  }

  /** Value badge: rounded rect sized to its text; returns the group and a setter for the live text. */
  function badge(/** @type {number} */ x, /** @type {number} */ y, /** @type {string} */ value, /** @type {{ w?: number, cls?: string, anchor?: string, tip?: string }} */ o = {}) {
    const d = dom();
    const w = o.w || Math.max(34, Math.round(value.length * CHAR_W + 12));
    const x0 = o.anchor === 'middle' ? x - w / 2 : o.anchor === 'end' ? x - w : x;
    const rect = d.svg('rect', { x: x0, y: y - 11, width: w, height: 16, rx: 8, class: 'sg-badge-bg' });
    const txt = d.svg('text', { x: x0 + w / 2, y: y + 1, class: 'sg-t sg-badge-t', 'text-anchor': 'middle' }, value);
    const title = d.svg('title', {}, o.tip || '');
    const grp = d.svg('g', { class: `sg-badge${o.cls ? ` ${o.cls}` : ''}` }, rect, txt, title);
    return {
      node: grp,
      set(/** @type {string} */ v, /** @type {string} */ tip) {
        txt.textContent = v;
        if (tip !== undefined) title.textContent = tip;
        grp.classList.toggle('na', /^(n\/a|—)/.test(v));
      },
    };
  }

  /** Bow-tie valve symbol at (x, y); the badge is placed by the caller. */
  function valve(/** @type {number} */ x, /** @type {number} */ y, /** @type {boolean} */ open) {
    return dom().svg('polygon', { points: `${x - 8},${y - 7} ${x + 8},${y + 7} ${x + 8},${y - 7} ${x - 8},${y + 7}`, class: open ? 'sg-valve open' : 'sg-valve' });
  }

  /** Small glyph for a component kind, inside a 18 x 18 square at (x, y). */
  function glyph(/** @type {string} */ kind, /** @type {number} */ x, /** @type {number} */ y) {
    const d = dom();
    const cx = x + 9;
    const cy = y + 9;
    if (kind === 'fan') return d.svg('g', { class: 'sg-glyph' }, d.svg('circle', { cx, cy, r: 8 }), d.svg('path', { d: `M ${cx} ${cy} L ${cx} ${cy - 7} M ${cx} ${cy} L ${cx + 6} ${cy + 4} M ${cx} ${cy} L ${cx - 6} ${cy + 4}` }));
    if (/coil/.test(kind)) return d.svg('path', { d: `M ${x} ${cy} l 3 -6 l 4 12 l 4 -12 l 4 12 l 3 -6`, class: 'sg-glyph' });
    if (kind === 'damper') return d.svg('path', { d: `M ${x + 2} ${y + 16} L ${x + 16} ${y + 2} M ${x} ${y + 9} h 3 M ${x + 15} ${y + 9} h 3`, class: 'sg-glyph' });
    if (kind === 'filter') return d.svg('path', { d: `M ${x + 3} ${y + 1} v 16 M ${x + 9} ${y + 1} v 16 M ${x + 15} ${y + 1} v 16`, class: 'sg-glyph' });
    if (kind === 'pump') return d.svg('g', { class: 'sg-glyph' }, d.svg('circle', { cx, cy, r: 8 }), d.svg('path', { d: `M ${cx - 3} ${cy + 4} L ${cx + 5} ${cy} L ${cx - 3} ${cy - 4} Z` }));
    if (kind === 'boiler' || kind === 'chiller') return d.svg('rect', { x: x + 2, y: y + 2, width: 14, height: 14, rx: 2, class: 'sg-glyph' });
    return d.svg('path', { d: `M ${x + 2} ${y + 9} h 14`, class: 'sg-glyph' });
  }

  /** Polyline pipe or duct. */
  function line(/** @type {number[][]} */ pts, /** @type {string} */ cls) {
    return dom().svg('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: cls, fill: 'none' });
  }

  /** @param {number[]} rgb 0..1 @returns {string} */
  const rgbAttr = (rgb) => `rgb(${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(',')})`;

  // ---- the Functional test graphic ----

  const kindClass = (/** @type {string} */ kind) => `sg-${String(kind || 'equipment').replace(/[^a-z]+/gi, '-').toLowerCase()}`;
  const onOffOrPct = (/** @type {any} */ v) => (v === null || v === undefined ? '—' : (v === 0 || v === 1 ? (v ? 'on' : 'off') : `${fmt(v)}%`));

  /**
   * Draw the unit into host. Same contract the 3D scene had: update(frame, marks), resize(), dispose().
   * @param {HTMLElement} host
   * @param {any} layout NfftGraphic.layout()
   * @param {{ pressureColor?: (pa: number, limit: number) => number[], staticLimitPa?: number }} opts
   */
  function createGraphic(host, layout, opts) {
    const d = dom();
    const lay = layout2d(layout);
    /** @type {any[]} */
    const parts = [];
    /** @type {Map<string, SVGElement>} */
    const boxes = new Map();
    /** @type {Map<string, SVGElement[]>} */
    const marked = new Map();
    /** @type {{ set: (v: string, tip?: string) => void }[]} */
    const reads = [];
    /** @type {any[]} */
    const updaters = [];
    const add = (/** @type {any} */ n) => { parts.push(n); return n; };

    // Air path and ducts first, so boxes sit on top.
    const ductNodes = /** @type {any[]} */ ([]);
    const trunk = d.svg('polyline', { points: '', class: 'sg-duct', fill: 'none' });
    ductNodes.push(trunk);
    add(trunk);
    const airPts = [[lay.casing.x - 14, lay.airY], [lay.casing.x + lay.casing.w + 14, lay.airY]];
    if (layout.terminals.length) airPts.push([lay.riserX, lay.airY], [lay.riserX, lay.buses[lay.buses.length - 1].y]);
    trunk.setAttribute('points', airPts.map((p) => p.join(',')).join(' '));
    for (const b of lay.buses) {
      const bus = line([[b.x1, b.y], [b.x2, b.y]], 'sg-duct sg-duct-bus');
      ductNodes.push(bus);
      add(bus);
    }
    // Hydronic pipes from the plants to the coils.
    for (const p of layout.pipes || []) {
      const m = /^pipe_(.+)_(.+)_sup$/.exec(p.id);
      if (!m) continue;
      const plantId = lay.slots[m[1]] ? m[1] : (layout.plants.find((/** @type {any} */ x) => p.id.startsWith(`pipe_${x.id}_`)) || {}).id;
      const coilId = plantId ? p.id.slice(`pipe_${plantId}_`.length, -'_sup'.length) : null;
      const path = plantId && coilId ? pipePath(lay, plantId, coilId, p.medium) : null;
      if (path) add(line(path, `sg-pipe ${p.medium === 'hot_water' ? 'sg-hw' : 'sg-chw'}`));
    }
    // Casing.
    add(d.svg('rect', { x: lay.casing.x, y: lay.casing.y, width: lay.casing.w, height: lay.casing.h, rx: 8, class: 'sg-casing' }));
    add(text(lay.casing.x + 10, lay.casing.y + 16, lay.casing.label, { max: 26, cls: 'sg-t sg-title', anchor: 'start' }));

    // Components.
    for (const s of Object.values(lay.slots)) {
      if (s.host) continue;
      const g1 = d.svg('g', { class: `sg-comp ${kindClass(s.kind)}` });
      const rect = d.svg('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 6, class: 'sg-box' });
      g1.appendChild(rect);
      g1.appendChild(glyph(s.kind, s.x + s.w - 24, s.y + 6));
      g1.appendChild(label(s.x + 7, s.y + 16, s.label, 11));
      const tip = d.svg('title', {}, `${s.label} (${s.kind})`);
      g1.appendChild(tip);
      let b = null;
      if (s.command || s.kind === 'fan') {
        b = badge(s.x + 7, s.y + s.h - 9, '—', { w: s.w - 14 });
        g1.appendChild(b.node);
      }
      boxes.set(s.id, rect);
      add(g1);
      updaters.push((/** @type {any} */ frame) => {
        if (!b) return;
        const v = s.command ? numOf(frame.values[s.command]) : null;
        let txt;
        if (s.kind === 'fan') txt = `${fmt(frame.scene.fanSpeed)}% · ${fmt(frame.scene.staticPa)} Pa`;
        else if (s.scope === 'plant') txt = onOffOrPct(v);
        else txt = v === null ? '—' : `${fmt(v)}%`;
        b.set(txt, `${s.label}${v === null && s.kind !== 'fan' ? ': no reading' : `: ${txt}`}`);
      });
    }
    // Valves on their coil's pipe drop.
    for (const s of Object.values(lay.slots)) {
      if (!s.host) continue;
      const cx = s.x + 9;
      const cy = s.y + 8;
      const host1 = lay.slots[s.host];
      const medium = host1 && /cool/.test(host1.kind) ? 'sg-chw' : 'sg-hw';
      const stub = line([[cx, cy + 8], [cx, lay.casing.y]], `sg-pipe ${medium} sg-stub`);
      const vNode = valve(cx, cy, false);
      const b = badge(cx + 12, cy + 4, '—', { w: 40 });
      const g1 = d.svg('g', { class: 'sg-comp sg-valve-g' }, stub, vNode, b.node, d.svg('title', {}, s.label));
      add(g1);
      updaters.push((/** @type {any} */ frame) => {
        const v = s.command ? numOf(frame.values[s.command]) : null;
        vNode.setAttribute('class', v !== null && v > 5 ? 'sg-valve open' : 'sg-valve');
        b.set(v === null ? '—' : `${fmt(v)}%`, `${s.label}: ${v === null ? 'no reading' : `${fmt(v)}%`}`);
      });
    }
    // Readout strip under the casing.
    const readNames = ['Fan', 'Static', 'SAT', 'MAT', 'Outdoor air'];
    readNames.forEach((name, i) => {
      const r = lay.reads[i];
      const nm = text(r.x + 2, r.y + 4, name, { max: 12, cls: 'sg-t sg-muted', anchor: 'start' });
      const b = badge(r.x + 58, r.y + 8, '—', { w: 56 });
      add(d.svg('g', {}, nm, b.node));
      reads.push(b);
    });
    // Terminals.
    /** @type {any[]} */
    const terms = layout.terminals.map((/** @type {any} */ t, /** @type {number} */ i) => {
      const s = lay.terminals[i];
      const g1 = d.svg('g', { class: 'sg-comp sg-terminal' });
      const rect = d.svg('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 6, class: 'sg-box' });
      const drop = line([[s.x + s.w / 2, lay.buses[s.row].y], [s.x + s.w / 2, s.y]], 'sg-duct sg-duct-drop');
      ductNodes.push(drop);
      add(drop);
      g1.appendChild(rect);
      g1.appendChild(label(s.x + 7, s.y + 14, t.label, 16));
      const track = d.svg('rect', { x: s.x + 7, y: s.y + 42, width: s.w - 14, height: 7, rx: 3, class: 'sg-track' });
      const fill = d.svg('rect', { x: s.x + 7, y: s.y + 42, width: 0, height: 7, rx: 3, class: 'sg-fill' });
      g1.appendChild(track);
      g1.appendChild(fill);
      const flow = badge(s.x + 7, s.y + 64, '—', { w: 44 });
      const dmp = badge(s.x + 54, s.y + 64, '—', { w: 43 });
      const rh = badge(s.x + 7, s.y + 82, '—', { w: 44 });
      const zone = badge(s.x + 54, s.y + 82, '—', { w: 43 });
      for (const b of [flow, dmp, rh, zone]) g1.appendChild(b.node);
      g1.appendChild(d.svg('title', {}, `${t.label}${t.zone ? ` · zone ${t.zone.label}` : ''}`));
      boxes.set(t.id, rect);
      for (const id of [t.damper, t.reheat, t.valve].filter(Boolean)) {
        if (!marked.has(id)) marked.set(id, []);
        /** @type {SVGElement[]} */ (marked.get(id)).push(rect);
      }
      add(g1);
      return { t, s, fill, flow, dmp, rh, zone, drop };
    });
    // Legend line for badge meaning.
    const legend = text(lay.casing.x, lay.height - 8, 'Terminal badges: airflow · damper position · reheat valve · zone temperature', { max: 90, cls: 'sg-t sg-muted', anchor: 'start' });
    add(legend);

    const svg = d.svg('svg', { viewBox: `0 0 ${lay.width} ${lay.height + 10}`, width: lay.width, class: 'sg-svg', role: 'img', 'aria-label': `${lay.casing.label} schematic` }, parts);
    host.replaceChildren(svg);

    function numOf(/** @type {any} */ v) {
      if (v && typeof v === 'object') v = v.value;
      if (v === true) return 1;
      if (v === false) return 0;
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    return {
      update(/** @type {any} */ frame, /** @type {{ overridden?: string[], faulted?: string[] }} */ marks = {}) {
        if (!frame || !frame.scene) return;
        const sc = frame.scene;
        for (const u of updaters) u(frame);
        for (const x of terms) {
          const ts = sc.terminals[x.t.index];
          if (!ts) continue;
          x.fill.setAttribute('width', String(Math.max(0, Math.min(100, ts.blade)) / 100 * (x.s.w - 14)));
          x.flow.set(ts.flowKnown === false ? '—' : `${fmt(ts.flowLps)} L/s`, 'Discharge airflow');
          x.dmp.set(`${fmt(ts.feedback !== null && ts.feedback !== undefined ? ts.feedback : ts.blade)}%`, `Damper position${ts.command !== null && ts.command !== undefined ? ` (command ${fmt(ts.command)}%)` : ''}`);
          x.rh.set(x.t.reheat || x.t.valve ? `RH ${fmt(ts.reheat)}%` : '—', 'Reheat valve position');
          x.zone.set(ts.zoneTemp === null || ts.zoneTemp === undefined ? '—' : `${fmt(ts.zoneTemp, 1)}°C`, x.t.zone ? `${x.t.zone.label} temperature` : 'Zone temperature');
        }
        reads[0].set(`${fmt(sc.fanSpeed)}%`, 'Supply fan speed');
        reads[1].set(`${fmt(sc.staticPa)} Pa`, 'Duct static pressure');
        reads[2].set(sc.sat === null || sc.sat === undefined ? '—' : `${fmt(sc.sat, 1)}°C`, 'Supply air temperature');
        reads[3].set(sc.mat === null || sc.mat === undefined ? '—' : `${fmt(sc.mat, 1)}°C`, 'Mixed air temperature');
        reads[4].set(`${fmt(sc.oaFraction * 100)}%`, 'Outdoor air fraction');
        if (opts && opts.pressureColor) {
          const limit = opts.staticLimitPa || 1;
          for (const n of ductNodes) n.setAttribute('stroke', rgbAttr(opts.pressureColor(sc.staticPa * (n.getAttribute('class') && /drop/.test(String(n.getAttribute('class'))) ? 0.92 : 1), limit)));
        }
        const amber = new Set(marks.overridden || []);
        const red = new Set(marks.faulted || []);
        for (const [id, rect] of boxes) {
          rect.classList.toggle('red', red.has(id));
          rect.classList.toggle('amber', amber.has(id) && !red.has(id));
        }
        for (const [id, list] of marked) {
          for (const rect of list) {
            if (red.has(id)) { rect.classList.add('red'); rect.classList.remove('amber'); } else if (amber.has(id)) rect.classList.add('amber');
          }
        }
      },
      resize() { /* the SVG scales with its host through its viewBox */ },
      dispose() { host.replaceChildren(); },
    };
  }

  return { truncate, wrapLabel, slotX, gridCell, layout2d, pipePath, GEO, CHAR_W, fmt, text, label, badge, valve, glyph, line, createGraphic };
});