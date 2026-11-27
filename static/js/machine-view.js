// Animated state machine and countdown rings. Built once, then classes and text update every second.
// Browser global NfftMachineView.
(function (root) {
  'use strict';

  const D = () => /** @type {any} */ (root).NfftDom;
  const V = () => /** @type {any} */ (root).NfftStateView;

  const W = 104;
  const H = 54;
  const GAP = 18;
  const X0 = 16;
  const Y = 58;
  const SUB = {
    IDLE: 'no run',
    SCHEDULED: 'NF scheduled hook',
    PRECHECK: 'interlocks, freshness',
    OVERRIDE: 'command writes',
    SETTLE: 'excluded window',
    CAPTURE: 'high-rate samples',
    RELEASE: 'cancel + verify',
    REPORT: 'manifest',
  };

  /**
   * @param {HTMLElement} host
   */
  function mount(host) {
    const d = D();
    const nodes = V().NODES;
    const width = X0 * 2 + nodes.length * W + (nodes.length - 1) * GAP;
    const xOf = (/** @type {number} */ i) => X0 + i * (W + GAP);
    const releaseX = xOf(nodes.indexOf('RELEASE'));
    const svg = d.svg('svg', { viewBox: `0 0 ${width} 214`, role: 'img', 'aria-label': 'Run state machine' });
    const defs = d.svg('defs', {}, d.svg('marker', { id: 'smArrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' },
      d.svg('path', { d: 'M0,0 L10,5 L0,10 z', class: 'sm-arrow' })));
    svg.appendChild(defs);
    /** @type {Record<string, Element>} */
    const edges = {};
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const e = d.svg('path', { d: `M${xOf(i) + W},${Y + H / 2} L${xOf(i + 1) - 2},${Y + H / 2}`, class: 'sm-edge', 'marker-end': 'url(#smArrow)' });
      edges[nodes[i + 1]] = e;
      svg.appendChild(e);
    }
    const last = xOf(nodes.length - 1);
    svg.appendChild(d.svg('path', { d: `M${last + W / 2},${Y} C${last + W / 2},${Y - 46} ${xOf(0) + W / 2},${Y - 46} ${xOf(0) + W / 2},${Y - 2}`, class: 'sm-edge loop', 'marker-end': 'url(#smArrow)' }));
    svg.appendChild(d.svg('text', { x: (last + xOf(0) + W) / 2, y: Y - 40, 'text-anchor': 'middle', class: 'sm-note', fill: 'currentColor', 'font-size': '11', opacity: '.6' }, 'back to idle after the manifest is written'));
    // Every abnormal event during a step goes through RELEASE.
    const o = xOf(nodes.indexOf('OVERRIDE'));
    const c = xOf(nodes.indexOf('CAPTURE')) + W;
    const pre = xOf(nodes.indexOf('PRECHECK'));
    svg.appendChild(d.svg('path', { d: `M${pre + W / 2},${Y + H} L${pre + W / 2},${Y + H + 22} L${releaseX + W / 2 - 6},${Y + H + 22} L${releaseX + W / 2 - 6},${Y + H + 2}`, class: 'sm-edge fault', 'marker-end': 'url(#smArrow)' }));
    svg.appendChild(d.svg('text', { x: (o + c) / 2, y: Y + H + 36, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': '11', opacity: '.75' }, 'abort · interlock · timeout · comm loss · write error → release'));
    // NEEDS_ATTENTION below RELEASE.
    const att = d.svg('g', { class: 'sm-node', transform: `translate(${releaseX + W + GAP / 2},${Y + H + 52})` },
      d.svg('rect', { width: W + 30, height: 44, rx: 10 }),
      d.svg('text', { x: (W + 30) / 2, y: 20, 'text-anchor': 'middle' }, 'NEEDS_ATTENTION'),
      d.svg('text', { x: (W + 30) / 2, y: 35, 'text-anchor': 'middle', class: 'sm-sub' }, 'release not verified'));
    svg.appendChild(d.svg('path', { d: `M${releaseX + W - 10},${Y + H} L${releaseX + W - 10},${Y + H + 74} L${releaseX + W + GAP / 2 - 2},${Y + H + 74}`, class: 'sm-edge fault', 'marker-end': 'url(#smArrow)' }));
    svg.appendChild(att);
    /** @type {Record<string, { g: Element, sub: Element }>} */
    const groups = {};
    nodes.forEach((/** @type {string} */ id, /** @type {number} */ i) => {
      const sub = d.svg('text', { x: W / 2, y: 40, 'text-anchor': 'middle', class: 'sm-sub' }, /** @type {any} */ (SUB)[id]);
      const g = d.svg('g', { class: 'sm-node', transform: `translate(${xOf(i)},${Y})` },
        d.svg('rect', { width: W, height: H, rx: 12 }),
        d.svg('text', { x: W / 2, y: 24, 'text-anchor': 'middle' }, id),
        sub);
      groups[id] = { g, sub };
      svg.appendChild(g);
    });
    d.fill(host, svg);
    return {
      /**
       * @param {any} view stateview.view()
       */
      update(view) {
        for (const p of view.path) {
          const entry = groups[p.id];
          let cls = `sm-node ${p.status}`;
          if (p.id === 'REPORT' && view.node === 'REPORT' && view.outcome) cls += ` outcome-${view.outcome}`;
          entry.g.setAttribute('class', cls);
          if (edges[p.id]) edges[p.id].setAttribute('class', `sm-edge${p.status !== 'todo' ? ' done' : ''}`);
          let sub = /** @type {any} */ (SUB)[p.id];
          if (view.step && ['OVERRIDE', 'SETTLE', 'CAPTURE'].includes(p.id) && view.node === p.id) sub = `step ${view.step.n}/${view.step.total} ${view.step.step_id}`;
          if (p.id === 'REPORT' && view.outcome) sub = view.outcome;
          entry.sub.textContent = sub;
        }
        att.setAttribute('class', `sm-node${view.attention ? ' attention' : ''}`);
      },
    };
  }

  /**
   * Countdown rings: one per countdown in the view.
   * @param {HTMLElement} host
   * @param {any[]} countdowns
   */
  function rings(host, countdowns) {
    const d = D();
    const r = 38;
    const len = 2 * Math.PI * r;
    const keep = new Set(countdowns.map((c) => c.id));
    for (const child of [...host.children]) {
      if (!keep.has(/** @type {HTMLElement} */ (child).dataset.id || '')) child.remove();
    }
    for (const c of countdowns) {
      let box = /** @type {HTMLElement | null} */ (host.querySelector(`[data-id="${c.id}"]`));
      if (!box) {
        const bar = d.svg('circle', { class: 'bar', cx: 46, cy: 46, r, 'stroke-dasharray': len.toFixed(1), transform: 'rotate(-90 46 46)' });
        const text = d.svg('text', { class: 't', x: 46, y: 51, 'text-anchor': 'middle' });
        box = d.el('div', { class: `ring ${c.id === 'next_trigger' ? 'next' : c.id}`, dataset: { id: c.id } },
          d.svg('svg', { viewBox: '0 0 92 92' }, d.svg('circle', { class: 'track', cx: 46, cy: 46, r }), bar, text),
          d.el('span', { text: c.label }));
        host.appendChild(box);
      }
      const frac = c.total_ms > 0 ? Math.max(0, Math.min(1, c.remaining_ms / c.total_ms)) : 1;
      const bar = /** @type {Element} */ (box.querySelector('.bar'));
      bar.setAttribute('stroke-dashoffset', (len * (1 - frac)).toFixed(1));
      const days = Math.floor(c.remaining_ms / 86400000);
      /** @type {Element} */ (box.querySelector('.t')).textContent = days > 0 ? `${days}d ${Math.floor((c.remaining_ms % 86400000) / 3600000)}h` : V().formatCountdown(c.remaining_ms);
      /** @type {Element} */ (box.querySelector('span')).textContent = c.label;
    }
  }

  root.NfftMachineView = { mount, rings };
})(globalThis);
