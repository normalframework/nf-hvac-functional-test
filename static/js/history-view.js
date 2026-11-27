// Run history (ECharts timeline + table), NF hook runs, and the overview step timeline. Browser global NfftHistoryView.
(function (root) {
  'use strict';

  const D = () => /** @type {any} */ (root).NfftDom;
  const OUTCOME_COLOR = { pass: '--good', fail: '--hot', aborted: '--warm', skipped: '--muted' };

  /**
   * Merge demo or manifest runs with the trigger's decisions. Newest first.
   * @param {any[]} runs
   * @param {any[]} decisions trigger history entries
   */
  function rows(runs, decisions) {
    const out = (runs || []).map((r) => ({ ...r, at: Date.parse(r.at), source: 'run' }));
    for (const h of decisions || []) {
      if (h.action === 'skip') out.push({ at: h.occurrence || h.at, outcome: 'skipped', live: false, reason: h.reason, run_id: '', steps: [], source: 'trigger' });
      else if (h.action === 'start' && !out.some((r) => r.run_id && r.run_id === h.run_id)) {
        out.push({ at: h.occurrence || h.at, outcome: 'started', live: h.live, reason: h.live ? 'armed' : 'dry_run', run_id: h.run_id, steps: [], source: 'trigger' });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * Axis bound a week past the first or last run.
   * @param {any[]} list
   * @param {number} side -1 for min, 1 for max
   */
  function span(list, side) {
    if (!list.length) return undefined;
    const times = list.map((r) => r.at);
    return (side < 0 ? Math.min(...times) : Math.max(...times)) + side * 7 * 86400000;
  }

  /**
   * @param {HTMLElement} chartHost
   * @param {HTMLElement} tableHost
   * @param {any[]} list from rows()
   * @param {string} tz
   */
  function render(chartHost, tableHost, list, tz) {
    const d = D();
    const R = /** @type {any} */ (root).NfftRrule;
    const outcomes = ['pass', 'aborted', 'fail', 'skipped', 'started'];
    const series = outcomes.map((o) => ({
      name: o,
      type: 'scatter',
      symbol: o === 'skipped' ? 'emptyDiamond' : 'diamond',
      symbolSize: (/** @type {any[]} */ v) => 10 + Math.min(18, (v[2] || 0) / 6),
      itemStyle: { color: d.cssVar(/** @type {any} */ (OUTCOME_COLOR)[o] || '--accent') },
      data: list.filter((r) => r.outcome === o).map((r) => [r.at, r.live ? 'live' : 'dry run', (r.steps || []).reduce((/** @type {number} */ a, /** @type {any} */ s) => a + s[1], 0), r.reason]),
    }));
    d.chart(chartHost, {
      grid: { left: 70, right: 20, top: 30, bottom: 40 },
      legend: { top: 0 },
      tooltip: {
        trigger: 'item',
        formatter: (/** @type {any} */ p) => `${R.formatLocal(p.value[0], tz)}<br>${p.seriesName} · ${p.value[1]}<br>${p.value[2] ? `${p.value[2]} min · ` : ''}${p.value[3] || ''}`,
      },
      xAxis: { type: 'time', min: span(list, -1), max: span(list, 1) },
      yAxis: { type: 'category', data: ['dry run', 'live'], axisLine: { show: false } },
      series,
    });
    d.fill(tableHost, d.el('table', { class: 'bac' },
      d.el('thead', {}, d.el('tr', {}, ...['When (site)', 'UTC', 'Mode', 'Outcome', 'Reason', 'Steps', 'Run'].map((h) => d.el('th', { text: h })))),
      d.el('tbody', {}, ...list.map((r) => d.el('tr', {},
        d.el('td', { text: R.formatLocal(r.at, tz) }),
        d.el('td', { class: 'sub', text: R.formatUtc(r.at) }),
        d.el('td', { text: r.live ? 'live' : 'dry run' }),
        d.el('td', {}, d.el('span', { class: `hist-out ${r.outcome}`, text: r.outcome })),
        d.el('td', { class: 'mono', text: r.reason || '' }),
        d.el('td', { class: 'sub', text: (r.steps || []).map((/** @type {any} */ s) => `${s[0]} ${s[1]}m`).join(' · ') }),
        d.el('td', { class: 'mono sub', text: r.run_id || '' }))))));
  }

  /**
   * @param {HTMLElement} host
   * @param {Record<string, any[]>} byHook
   */
  function hookRuns(host, byHook) {
    const d = D();
    const all = Object.entries(byHook).flatMap(([hook, runs]) => (runs || []).map((r) => ({ hook, ...r })));
    all.sort((a, b) => Date.parse(b.start_time || b.startTime || 0) - Date.parse(a.start_time || a.startTime || 0));
    d.fill(host, all.length ? d.el('table', { class: 'bac' },
      d.el('thead', {}, d.el('tr', {}, ...['Hook', 'Started', 'State', 'Duration', 'PID'].map((h) => d.el('th', { text: h })))),
      d.el('tbody', {}, ...all.slice(0, 16).map((r) => d.el('tr', {},
        d.el('td', { class: 'mono', text: r.hook }),
        d.el('td', { text: new Date(r.start_time || r.startTime || 0).toLocaleString() }),
        d.el('td', { class: String(r.state || '').includes('SUCCESS') ? 'ok' : String(r.state || '').includes('ERROR') ? 'bad' : '', text: String(r.state || '').replace('STATE_', '') }),
        d.el('td', { class: 'num', text: r.duration_ms !== undefined ? `${r.duration_ms} ms` : '' }),
        d.el('td', { class: 'mono sub', text: String(r.pid || '') })))))
      : d.el('p', { class: 'muted', text: 'No hook runs reported.' }));
  }

  /**
   * Overview step timeline: one bar per step, settle shaded, now marker while a run is active.
   * @param {HTMLElement} host
   * @param {any[]} steps runnable steps
   * @param {number | null} elapsedMs since run start, or null
   */
  function stepChart(host, steps, elapsedMs) {
    const d = D();
    let t = 0;
    const names = [];
    const offset = [];
    const settle = [];
    const capture = [];
    for (const s of steps) {
      names.push(s.step_id);
      offset.push(+(t / 60000).toFixed(2));
      const st = Math.min(s.settle_ms || 0, s.hold_ms || 0);
      settle.push(+(st / 60000).toFixed(2));
      capture.push(+(((s.hold_ms || 0) - st) / 60000).toFixed(2));
      t += s.hold_ms || 0;
    }
    const base = { type: 'bar', stack: 'steps', barWidth: 18 };
    d.chart(host, {
      grid: { left: 110, right: 24, top: 24, bottom: 36 },
      legend: { top: 0, data: ['settle', 'capture'] },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', name: 'minutes from start', nameLocation: 'middle', nameGap: 24 },
      yAxis: { type: 'category', data: names, inverse: true },
      series: [
        { ...base, name: 'offset', data: offset, itemStyle: { color: 'transparent' }, tooltip: { show: false }, silent: true },
        { ...base, name: 'settle', data: settle, itemStyle: { color: d.cssVar('--warm'), borderRadius: [4, 0, 0, 4] } },
        {
          ...base, name: 'capture', data: capture, itemStyle: { color: d.cssVar('--accent'), borderRadius: [0, 4, 4, 0] },
          markLine: elapsedMs === null ? undefined : { symbol: 'none', label: { formatter: 'now' }, lineStyle: { color: d.cssVar('--hot'), width: 2 }, data: [{ xAxis: +(elapsedMs / 60000).toFixed(2) }] },
        },
      ],
    });
  }

  root.NfftHistoryView = { rows, render, hookRuns, stepChart };
})(globalThis);
