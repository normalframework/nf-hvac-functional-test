// Small DOM, SVG, format and chart helpers for the page. Browser global NfftDom.
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * @param {Element} node
   * @param {Record<string, any>} attrs
   * @param {boolean} svg
   */
  function setAttrs(node, attrs, svg) {
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'class') node.setAttribute('class', String(value));
      else if (key === 'dataset') Object.assign(/** @type {HTMLElement} */ (node).dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'style') throw new Error('inline styles are blocked by the page CSP');
      else if (!svg && key in node && typeof value !== 'string') /** @type {any} */ (node)[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {...any} children
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    setAttrs(node, attrs || {}, false);
    append(node, children);
    return node;
  }

  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {...any} children
   */
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    setAttrs(node, attrs || {}, true);
    append(node, children);
    return node;
  }

  /**
   * @param {Node} node
   * @param {any[]} children
   */
  function append(node, children) {
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
  }

  /**
   * @param {Element | null} node
   * @param {...any} children
   */
  function fill(node, ...children) {
    if (!node) return;
    node.replaceChildren();
    append(node, children);
  }

  /**
   * @param {number} ms
   */
  function duration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0 min';
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  const UNIT_TEXT = { PERCENT: '%', PERCENT_RH: '%RH', DEG_C: '°C', DEG_F: '°F', PA: 'Pa', 'IN_H2O': 'inH₂O', 'M3-PER-SEC': 'm³/s', 'FT3-PER-MIN': 'cfm', 'L-PER-SEC': 'L/s', UNITLESS: '' };

  /**
   * QUDT local name to a short display unit.
   * @param {string | null | undefined} unit
   */
  function unitText(unit) {
    if (!unit) return '';
    const local = String(unit).replace(/^unit:/, '');
    return Object.prototype.hasOwnProperty.call(UNIT_TEXT, local) ? /** @type {Record<string, string>} */ (UNIT_TEXT)[local] : local;
  }

  /**
   * @param {any} value
   * @param {string | null | undefined} unit
   */
  function valueText(value, unit) {
    if (value === true) return 'on';
    if (value === false) return 'off';
    if (value === null || value === undefined) return 'none';
    const u = unitText(unit);
    return u ? `${value} ${u}` : String(value);
  }

  // Same chart themes as the Open-FDD NF app (theme.js), registered once.
  const AXIS = (/** @type {string} */ line, /** @type {string} */ label, /** @type {string} */ split) => ({
    axisLine: { lineStyle: { color: line } }, axisTick: { lineStyle: { color: line } },
    axisLabel: { color: label }, splitLine: { lineStyle: { color: split } }, nameTextStyle: { color: label },
  });
  const THEMES = {
    light: {
      color: ['#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#9333ea', '#dc2626'],
      backgroundColor: '#ffffff', textStyle: { color: '#1e3a8a' }, legend: { textStyle: { color: '#334155' } },
      tooltip: { backgroundColor: '#ffffffee', borderColor: '#2563eb', textStyle: { color: '#0f172a' } },
      categoryAxis: AXIS('#2563eb', '#475569', '#e2e8f0'), valueAxis: AXIS('#2563eb', '#475569', '#e2e8f0'), timeAxis: AXIS('#2563eb', '#475569', '#e2e8f0'),
    },
    dark: {
      color: ['#4cc9f0', '#f8961e', '#f94144', '#90be6d', '#b5179e', '#f9c74f', '#43aa8b', '#577590'],
      backgroundColor: 'transparent', textStyle: { color: '#e6ebf5' }, legend: { textStyle: { color: '#c9d2e8' } },
      tooltip: { backgroundColor: '#0f1730ee', borderColor: '#2b3858', textStyle: { color: '#e6ebf5' } },
      categoryAxis: AXIS('#2b3858', '#8a96b3', '#1c2640'), valueAxis: AXIS('#2b3858', '#8a96b3', '#1c2640'), timeAxis: AXIS('#2b3858', '#8a96b3', '#1c2640'),
    },
  };
  let registered = false;
  /** @type {Map<Element, any>} */
  const charts = new Map();

  function themeName() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  /**
   * @param {string} name
   */
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /**
   * Draw an ECharts option into a host element with the Open-FDD theme. Returns false when ECharts is not loaded.
   * @param {HTMLElement | null} host
   * @param {any} option
   */
  function chart(host, option) {
    const ec = /** @type {any} */ (root).echarts;
    if (!host || !ec) return false;
    if (!registered) {
      ec.registerTheme('ofdd-light', THEMES.light);
      ec.registerTheme('ofdd-dark', THEMES.dark);
      registered = true;
    }
    const theme = `ofdd-${themeName()}`;
    let entry = charts.get(host);
    if (!entry || entry.theme !== theme) {
      if (entry) entry.instance.dispose();
      entry = { theme, instance: ec.init(host, theme, { renderer: 'svg' }) };
      charts.set(host, entry);
    }
    entry.instance.setOption(option, true);
    host.classList.add('rendered');
    return true;
  }

  root.addEventListener('resize', () => {
    for (const entry of charts.values()) entry.instance.resize();
  });

  root.NfftDom = { el, svg, fill, duration, unitText, valueText, chart, cssVar, themeName };
})(globalThis);
