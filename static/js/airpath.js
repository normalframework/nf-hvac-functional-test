// "What the test touches": air path diagram plus device-by-device tables, from the touch map
// (core/touchmap.js), which is built from the site model's roles. Browser global NfftAirPath.
(function (root) {
  'use strict';

  const D = () => /** @type {any} */ (root).NfftDom;
  const DUCT_TOP = 150;
  const DUCT_H = 96;
  const LAYOUT = {
    outdoor: { x: 40, y: DUCT_TOP - 8 },
    return: { x: 205, y: 6 },
    mixing: { x: 205, y: DUCT_TOP - 8 },
    filter: { x: 370, y: DUCT_TOP - 8 },
    coils: { x: 535, y: DUCT_TOP - 8 },
    fan: { x: 700, y: DUCT_TOP - 8 },
    discharge: { x: 865, y: DUCT_TOP - 8 },
    safety: { x: 370, y: 330 },
    control: { x: 535, y: 330 },
  };
  const BW = 140;
  const BH = 112;

  /**
   * @param {string} role
   */
  function shortRole(role) {
    const text = role.replace(/_command$/, '').replace(/_operating_mode$/, '_mode').replace(/_position$/, '');
    return text.length > 24 ? `${text.slice(0, 23)}…` : text;
  }

  /**
   * @param {string} stage
   * @param {any[]} active writes in the chosen step for this stage
   */
  function glyph(stage, active) {
    const d = D();
    const g = d.svg('g', { transform: `translate(${BW / 2},${BH / 2 - 2})` });
    const valueOf = (/** @type {RegExp} */ re) => {
      const hit = active.find((a) => re.test(a.role));
      return hit ? Number(hit.value) : null;
    };
    if (stage === 'outdoor' || stage === 'return') {
      const v = valueOf(/damper/);
      const angle = v === null ? 35 : 90 * (1 - Math.max(0, Math.min(100, v)) / 100);
      g.appendChild(d.svg('rect', { x: -20, y: -26, width: 40, height: 52, rx: 3, class: 'ap-frame' }));
      for (const dy of [-16, 0, 16]) {
        g.appendChild(d.svg('line', { x1: -16, y1: 0, x2: 16, y2: 0, class: `ap-glyph${v !== null ? ' hot' : ''}`, transform: `translate(0,${dy}) rotate(${angle})` }));
      }
    } else if (stage === 'mixing') {
      g.appendChild(d.svg('path', { d: 'M-24,-14 Q0,-14 4,0 M-24,14 Q0,14 4,0 M4,0 L24,0', class: 'ap-glyph' }));
    } else if (stage === 'filter') {
      g.appendChild(d.svg('path', { d: 'M-8,-22 L8,-14 L-8,-6 L8,2 L-8,10 L8,18', class: 'ap-glyph' }));
    } else if (stage === 'coils') {
      const cool = valueOf(/cooling/);
      const heat = valueOf(/heating/);
      g.appendChild(d.svg('path', { d: 'M-30,-20 l6,8 l-6,8 l6,8 l-6,8 l6,8', class: `ap-glyph ${cool === null ? '' : cool > 0 ? 'cold' : ''}` }));
      g.appendChild(d.svg('path', { d: 'M10,-20 l6,8 l-6,8 l6,8 l-6,8 l6,8', class: `ap-glyph ${heat === null ? '' : heat > 0 ? 'hot' : ''}` }));
    } else if (stage === 'fan') {
      const blades = d.svg('g', { class: 'ap-glyph spin' });
      blades.appendChild(d.svg('circle', { r: 20, class: 'ap-glyph' }));
      for (const a of [0, 120, 240]) blades.appendChild(d.svg('path', { d: 'M0,0 Q10,-6 4,-18', class: 'ap-glyph', transform: `rotate(${a})` }));
      g.appendChild(blades);
    } else if (stage === 'discharge') {
      g.appendChild(d.svg('path', { d: 'M-24,0 L20,0 M12,-8 L22,0 L12,8', class: 'ap-glyph' }));
    } else if (stage === 'safety') {
      g.appendChild(d.svg('path', { d: 'M0,-20 L18,-12 L14,10 L0,20 L-14,10 L-18,-12 Z', class: 'ap-glyph hot' }));
    } else {
      g.appendChild(d.svg('rect', { x: -18, y: -14, width: 36, height: 28, rx: 4, class: 'ap-glyph' }));
    }
    return g;
  }

  /**
   * @param {HTMLElement} host
   * @param {any} map touch map
   * @param {number} stepN 1-based step, or 0 for none
   * @param {string} selected stage id
   * @param {(stage: string) => void} onPick
   * @param {any} units
   */
  function draw(host, map, stepN, selected, onPick, units) {
    const d = D();
    const ahu = map.devices.filter((/** @type {any} */ dev) => dev.type === 'ahu');
    const boxes = map.devices.filter((/** @type {any} */ dev) => dev.type !== 'ahu');
    const vavH = Math.max(1, boxes.length) * 44 + 20;
    const height = Math.max(440, DUCT_TOP + vavH);
    const svg = d.svg('svg', { viewBox: `0 0 1260 ${height}`, role: 'img', 'aria-label': 'Air path with the points the test reads and writes' });
    svg.appendChild(d.svg('rect', { x: 20, y: DUCT_TOP, width: 1010, height: DUCT_H, rx: 16, class: 'ap-duct' }));
    svg.appendChild(d.svg('rect', { x: 230, y: 70, width: 90, height: DUCT_TOP - 60, class: 'ap-duct' }));
    svg.appendChild(d.svg('path', { d: `M30,${DUCT_TOP + DUCT_H / 2} L1030,${DUCT_TOP + DUCT_H / 2}`, class: 'ap-flow' }));
    svg.appendChild(d.svg('path', { d: `M275,80 L275,${DUCT_TOP + 20}`, class: 'ap-flow' }));
    /** @type {Record<string, any[]>} */
    const byStage = {};
    for (const dev of ahu) {
      for (const p of dev.points) (byStage[p.stage] = byStage[p.stage] || []).push({ ...p, equipment_id: dev.equipment_id });
    }
    for (const [stage, pos] of Object.entries(LAYOUT)) {
      const points = byStage[stage] || [];
      const writes = points.filter((p) => p.mode === 'write');
      const active = writes.flatMap((p) => p.writes.filter((/** @type {any} */ w) => w.step_n === stepN).map((/** @type {any} */ w) => ({ role: p.role, value: w.value })));
      const label = (map.stages.find((/** @type {any} */ s) => s.id === stage) || { label: stage }).label;
      const g = d.svg('g', {
        class: `ap-stage${writes.length ? ' has-write' : ''}${active.length ? ' active' : ''}${selected === stage ? ' sel' : ''}`,
        transform: `translate(${pos.x},${pos.y})`, tabindex: '0', onclick: () => onPick(stage),
        onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') onPick(stage); },
      },
      d.svg('title', {}, `${label}: ${points.map((p) => `${p.role} (${p.mode})`).join(', ') || 'no bound points'}`),
      d.svg('rect', { class: 'box', width: BW, height: BH, rx: 12 }),
      d.svg('text', { class: 'title', x: 12, y: 20 }, label),
      glyph(stage, active),
      d.svg('text', { class: 'count', x: 12, y: BH - 10 }, `${points.length - writes.length} read · ${writes.length} written`));
      points.forEach((p, i) => g.appendChild(d.svg('circle', { cx: BW - 14 - i * 11, cy: 36, r: 4, class: p.mode === 'write' ? 'ap-dot write' : 'ap-dot read' })));
      active.forEach((a, i) => {
        const text = `${shortRole(a.role)} → ${D().valueText(a.value, units[a.role])}`;
        const chip = d.svg('g', { class: 'ap-pin write cmd', transform: `translate(0,${BH + 6 + i * 22})` },
          d.svg('title', {}, `${a.role} commanded to ${a.value} in step ${stepN}`),
          d.svg('rect', { width: Math.max(BW, text.length * 6.1 + 12), height: 18 }),
          d.svg('text', { x: 6, y: 13 }, text));
        g.appendChild(chip);
      });
      svg.appendChild(g);
    }
    // VAV fan-out.
    const vx = 1080;
    svg.appendChild(d.svg('path', { d: `M1030,${DUCT_TOP + DUCT_H / 2} L${vx - 10},${DUCT_TOP + DUCT_H / 2}`, class: 'ap-flow' }));
    svg.appendChild(d.svg('text', { x: vx, y: DUCT_TOP - 14, 'font-size': '13', 'font-weight': '650', fill: 'currentColor' }, `VAV zones (${boxes.length})`));
    boxes.forEach((/** @type {any} */ box, /** @type {number} */ i) => {
      const y = DUCT_TOP + i * 44;
      const active = box.points.flatMap((/** @type {any} */ p) => p.writes.filter((/** @type {any} */ w) => w.step_n === stepN).map((/** @type {any} */ w) => ({ role: p.role, value: w.value })));
      svg.appendChild(d.svg('path', { d: `M${vx - 10},${DUCT_TOP + DUCT_H / 2} L${vx - 10},${y + 18} L${vx},${y + 18}`, class: 'sm-edge' }));
      svg.appendChild(d.svg('g', { class: `ap-vav${box.written ? ' write' : ''}${active.length ? ' active' : ''}`, transform: `translate(${vx},${y})`, onclick: () => onPick(`vav:${box.equipment_id}`) },
        d.svg('title', {}, `${box.equipment_id}: ${box.points.map((/** @type {any} */ p) => `${p.role} (${p.mode})`).join(', ')}`),
        d.svg('rect', { width: 160, height: 36, rx: 8 }),
        d.svg('text', { x: 10, y: 15 }, box.equipment_id),
        d.svg('text', { x: 10, y: 29, opacity: '.7' }, active.length ? active.map((a) => `${shortRole(a.role)} → ${D().valueText(a.value, units[a.role])}`).join(', ') : `${box.reads} read · ${box.written} written`)));
    });
    d.fill(host, svg);
  }

  /**
   * @param {any} p point from the touch map
   * @param {any} units
   */
  function commandList(p, units) {
    const d = D();
    if (p.mode !== 'write') return d.el('span', { class: 'sub', text: 'read only' });
    return d.el('div', {},
      ...p.writes.map((/** @type {any} */ w) => d.el('span', { class: 'wstep' },
        `Step ${w.step_n} ${w.step_id}: `, d.el('b', { text: D().valueText(w.value, units[p.role]) }),
        ` · from +${D().duration(w.starts_after_ms)} · hold ${D().duration(w.hold_ms)}${w.settle_ms ? ` · settle ${D().duration(w.settle_ms)}` : ''}`)),
      d.el('span', { class: 'release', text: `Release: relinquish @ P${p.release.priority}${p.release.how ? ` · ${p.release.how}` : ''}` }));
  }

  /**
   * @param {HTMLElement} host
   * @param {any} map
   * @param {any} units
   */
  function devices(host, map, units) {
    const d = D();
    d.fill(host, ...map.devices.map((/** @type {any} */ dev) => d.el('div', { class: 'obj' },
      d.el('div', { class: 'dev-head' }, d.el('span', { class: 'id', text: dev.equipment_id }), d.el('span', { class: 'tag', text: dev.type.toUpperCase() }),
        d.el('span', { class: 'count', text: `${dev.reads} read · ${dev.written} written` })),
      d.el('table', { class: 'props' }, ...dev.points.map((/** @type {any} */ p) => d.el('tr', {},
        d.el('td', { text: p.role, title: `stage: ${p.stage}` }),
        d.el('td', {}, d.el('span', { class: `mode-chip ${p.mode}`, text: p.mode === 'write' ? 'written' : 'read' }), ' ', commandList(p, units))))))));
  }

  /**
   * @param {HTMLElement} host
   * @param {any} map
   * @param {string} selected
   * @param {any} units
   */
  function detail(host, map, selected, units) {
    const d = D();
    /** @type {any[]} */
    let rows = [];
    let title = '';
    if (selected.startsWith('vav:')) {
      const id = selected.slice(4);
      const dev = map.devices.find((/** @type {any} */ x) => x.equipment_id === id);
      title = id;
      rows = dev ? dev.points.map((/** @type {any} */ p) => ({ ...p, equipment_id: id })) : [];
    } else {
      title = (map.stages.find((/** @type {any} */ s) => s.id === selected) || { label: selected }).label;
      rows = map.devices.filter((/** @type {any} */ x) => x.type === 'ahu').flatMap((/** @type {any} */ dev) => dev.points.filter((/** @type {any} */ p) => p.stage === selected).map((/** @type {any} */ p) => ({ ...p, equipment_id: dev.equipment_id })));
    }
    d.fill(host, d.el('b', { text: title }),
      rows.length ? d.el('table', {}, ...rows.map((p) => d.el('tr', {}, d.el('td', { text: `${p.equipment_id} · ${p.role}` }),
        d.el('td', {}, d.el('span', { class: `mode-chip ${p.mode}`, text: p.mode === 'write' ? 'written' : 'read' }), ' ', commandList(p, units)))))
        : d.el('p', { class: 'sub', text: 'No points bound for this stage in the site model.' }));
  }

  root.NfftAirPath = { draw, devices, detail, shortRole };
})(globalThis);
