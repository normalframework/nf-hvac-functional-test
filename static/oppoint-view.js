// Operating point tab: pump and fan curves, system curve, operating point and a model-driven schematic for every
// waterside pump and every air handler fan. Resolution and math live in NfftOpModel / NfftOpMath (no DOM there).
// Charts always render: without nameplate data the curves are a normalized generic shape labelled illustrative,
// and a "Missing data" line names the exact tags a panel needs. Browser global NfftOperatingPointView.
(function (root) {
  'use strict';

  const g = /** @type {any} */ (root);
  const POLL_MS = 5000;
  const RECORDS_MS = 5 * 60 * 1000;
  const idOf = (/** @type {any} */ r) => (r.attrs || {}).id || r.name;

  /** @param {number|null|undefined} n @param {number} [digits] */
  function fmt(n, digits = 1) {
    if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
    const a = Math.abs(n);
    const d = a >= 1000 ? 0 : a >= 100 ? 0 : digits;
    return n.toFixed(d);
  }


  /**
   * @param {{ api: any, demo: boolean, notify: (text: string, bad?: boolean) => void }} o
   */
  function mount(o) {
    const d = g.NfftDom;
    const OM = g.NfftOpModel;
    const MATH = g.NfftOpMath;
    const host = document.getElementById('opointPanels');
    const statusEl = document.getElementById('opointStatus');
    /** @type {any} */
    let resolved = null;
    /** @type {Record<string, any>} */
    let values = {};
    let recordsAt = 0;
    /** @type {any} */
    let timer = null;
    let on = false;
    let busy = false;

    const cssColor = (/** @type {string} */ v, /** @type {string} */ fallback) => d.cssVar(v) || fallback;

    /** Axis scale and labels for one panel: SI display (L/s, kPa or Pa) or percent of design when normalized. */
    function axes(/** @type {any} */ entry, /** @type {any} */ r) {
      const fan = entry.kind === 'fan';
      if (r.curve.normalized) return { fx: (/** @type {number} */ q) => q * 100, fy: (/** @type {number} */ h) => h * 100, x: 'Flow (% of design, illustrative)', y: `${fan ? 'Pressure' : 'Head'} (% of design, illustrative)`, yDigits: 0 };
      return { fx: (/** @type {number} */ q) => q * 1000, fy: (/** @type {number} */ h) => (fan ? h : h / 1000), x: 'Flow (L/s)', y: fan ? 'Total pressure (Pa)' : 'Head (kPa)', yDigits: fan ? 0 : 1 };
    }

    /** ECharts option: curve at 100 percent speed, curve at the current speed, system curve, operating point, fixed-speed points. */
    function chartOption(/** @type {any} */ entry, /** @type {any} */ r) {
      const fan = entry.kind === 'fan';
      const ax = axes(entry, r);
      const cv = r.curve;
      const s = r.speed.fraction === null ? 1 : r.speed.fraction;
      const pts = (/** @type {[number, number][]} */ list) => list.map(([q, h]) => [ax.fx(q), ax.fy(h)]);
      const noun = fan ? 'Fan' : 'Pump';
      const tag = r.illustrative ? ' (illustrative)' : '';
      const qMax = Math.max(cv.designFlow * 1.6, r.op ? r.op.q * 1.3 : 0);
      const hMax = Math.max(cv.designHead * 1.5, r.op ? r.op.h * 1.3 : 0);
      const sysFull = MATH.sampleSystem(r.sys, qMax);
      const colorCurve = cssColor('--accent', '#2563eb');
      const colorSys = cssColor('--warm', '#ea580c');
      const colorOp = cssColor('--hot', '#dc2626');
      const muted = cssColor('--muted', '#64748b');
      /** @type {any[]} */
      const series = [
        { name: `${noun} curve, 100% speed${tag}`, type: 'line', showSymbol: false, data: pts(MATH.sampleCurve(cv, 1, 40, qMax)), lineStyle: { color: muted, type: 'dashed', width: 1.5 }, itemStyle: { color: muted } },
      ];
      if (Math.abs(s - 1) > 0.005) {
        series.push({ name: `${noun} curve at ${fmt(s * 100, 0)}% speed (affinity laws)${tag}`, type: 'line', showSymbol: false, data: pts(MATH.sampleCurve(cv, s, 40, qMax)), lineStyle: { color: colorCurve, width: 2.5 }, itemStyle: { color: colorCurve } });
      } else {
        series[0].lineStyle = { color: colorCurve, width: 2.5 };
        series[0].itemStyle = { color: colorCurve };
        series[0].name = `${noun} curve, 100% speed${tag}`;
      }
      series.push({ name: `System curve H = Hs + k·Q²${r.sys.source ? ` (${r.sys.source})` : ''}`, type: 'line', showSymbol: false, data: pts(sysFull), lineStyle: { color: colorSys, width: 2 }, itemStyle: { color: colorSys } });
      if (r.op) {
        series.push({
          name: 'Operating point', type: 'scatter', symbolSize: 14, data: [[ax.fx(r.op.q), ax.fy(r.op.h)]], itemStyle: { color: colorOp },
          // Sit above the point with a theme-colored pill so the text never sits on the curve lines.
          label: {
            show: true,
            position: 'top',
            distance: 10,
            color: colorOp,
            backgroundColor: cssColor('--panel', '#fff'),
            borderColor: cssColor('--line', '#e2e8f0'),
            borderWidth: 1,
            borderRadius: 3,
            padding: [3, 6],
            formatter: r.curve.normalized ? 'operating point' : `${fmt(r.op.q * 1000)} L/s, ${fan ? `${fmt(r.op.h, 0)} Pa` : `${fmt(r.op.h / 1000)} kPa`}`,
          },
        });
        if (r.cmp && r.cmp.rows.length > 1) {
          const thr = r.cmp.rows.find((/** @type {any} */ x) => x.id === 'throttled');
          const nat = r.cmp.rows.find((/** @type {any} */ x) => x.id === 'natural');
          if (thr) series.push({ name: 'Fixed speed, throttled to the same flow', type: 'scatter', symbol: 'diamond', symbolSize: 11, data: [[ax.fx(thr.q), ax.fy(thr.h)]], itemStyle: { color: 'transparent', borderColor: muted, borderWidth: 2 } });
          if (nat) series.push({ name: 'Fixed speed, wide open', type: 'scatter', symbol: 'circle', symbolSize: 10, data: [[ax.fx(nat.q), ax.fy(nat.h)]], itemStyle: { color: 'transparent', borderColor: colorSys, borderWidth: 2 } });
        }
      }
      return {
        animation: false,
        title: r.illustrative ? { text: 'ILLUSTRATIVE', left: 'center', top: 4, textStyle: { color: colorOp, fontSize: 12, fontWeight: 600 } } : undefined,
        grid: { left: 56, right: 18, top: r.illustrative ? 40 : 28, bottom: 100 },
        legend: { bottom: 0, type: 'plain', itemWidth: 16, itemHeight: 8, textStyle: { fontSize: 10 } },
        tooltip: { trigger: 'item' },
        xAxis: { type: 'value', name: ax.x, nameLocation: 'middle', nameGap: 26, min: 0, max: ax.fx(qMax), axisLabel: { formatter: (/** @type {number} */ v) => fmt(v, 0) } },
        yAxis: { type: 'value', name: ax.y, nameLocation: 'middle', nameGap: 40, min: 0, max: ax.fy(hMax), axisLabel: { formatter: (/** @type {number} */ v) => fmt(v, ax.yDigits) } },
        series,
      };
    }

    const SG = g.NfftSchematic;
    /** Text at a slot: truncated to max characters, full text as a tooltip (shared with the Functional test graphic). */
    const T = (/** @type {number} */ x, /** @type {number} */ y, /** @type {string} */ text, /** @type {string} */ cls, /** @type {number} */ max = 22, /** @type {string|undefined} */ anchor = undefined) => SG.text(x, y, text, {
      max, cls: `sg-t${/op-muted/.test(cls || '') ? ' sg-muted' : ''}${/op-t-sm/.test(cls || '') ? ' sg-sm' : ''}`, anchor,
    });
    const pctText = (/** @type {number|null|undefined} */ v) => (v === null || v === undefined ? 'n/a' : `${fmt(v, 0)}%`);
    const num = (/** @type {any} */ entry, /** @type {string} */ key) => {
      const r = OM.readQuantity(entry, values, key);
      return r ? r.value : null;
    };

    /** A bow-tie valve with its position. */
    function valveSymbol(/** @type {number} */ x, /** @type {number} */ y, /** @type {number|null} */ pct) {
      const open = pct !== null && pct > 5;
      // The percent sits beside the valve, off the pipe.
      return [SG.valve(x, y, open), SG.text(x + 12, y + 4, pctText(pct), { max: 6, anchor: 'start', cls: `sg-t${pct === null ? ' sg-muted' : ''}` })];
    }

    /** Pump loop schematic: pump with VFD, loop members with live valve percent, flow meter, DP sensor with setpoint. */
    function pumpSchematic(/** @type {any} */ entry, /** @type {any} */ r) {
      const medCls = entry.medium === 'hw' ? 'op-pipe op-hw' : 'op-pipe op-chw';
      const parts = /** @type {any[]} */ ([]);
      const left = 110;
      const rightX = 520;
      const top = 54;
      const bottom = 262;
      parts.push(d.svg('line', { x1: left, y1: top, x2: rightX, y2: top, class: medCls }));
      parts.push(d.svg('line', { x1: left, y1: bottom, x2: rightX, y2: bottom, class: `${medCls} op-return` }));
      parts.push(d.svg('line', { x1: left, y1: top, x2: left, y2: bottom, class: medCls }));
      parts.push(T(rightX - 4, top - 8, 'supply', 'op-t op-muted'));
      parts.push(T(rightX - 4, bottom + 14, 'return', 'op-t op-muted'));
      // Pump and VFD on the riser.
      const py = 160;
      parts.push(d.svg('circle', { cx: left, cy: py, r: 24, class: 'op-node' }));
      parts.push(d.svg('path', { d: `M ${left - 10} ${py + 8} L ${left + 10} ${py} L ${left - 10} ${py - 8} Z`, class: 'op-pump-arrow' }));
      parts.push(d.svg('rect', { x: left - 56, y: py - 40, width: 40, height: 20, rx: 3, class: 'op-box' }));
      parts.push(T(left - 36, py - 26, 'VFD', 'op-t op-t-sm'));
      parts.push(d.svg('line', { x1: left - 36, y1: py - 20, x2: left - 20, y2: py - 8, class: 'op-wire' }));
      const hzText = r.speed.hz === null ? 'speed n/a' : `${fmt(r.speed.hz)} Hz · ${pctText(r.speed.fraction === null ? null : r.speed.fraction * 100)}`;
      parts.push(T(left - 36, py + 42, hzText, r.speed.known ? 'op-t' : 'op-t op-muted'));
      parts.push(T(left - 36, py + 56, r.powerW === null ? 'kW n/a' : `${fmt(r.powerW / 1000, 2)} kW`, r.measuredPower !== null ? 'op-t' : 'op-t op-muted'));
      parts.push(T(left - 36, py + 70, entry.label, 'op-t op-t-sm', 18));
      // Flow meter.
      parts.push(d.svg('circle', { cx: left, cy: 96, r: 10, class: 'op-node op-sensor' }));
      parts.push(T(left, 100, 'F', 'op-t op-t-sm'));
      parts.push(T(left + 36, 99, r.flow === null ? 'n/a' : `${fmt(r.flow * 1000)} L/s`, r.flow === null ? 'op-t op-muted' : 'op-t'));
      // Branches: coil valves of the loop, then the VAV reheat group.
      const branches = /** @type {any[]} */ ([]);
      const MAX_COILS = 4;
      for (const b of entry.branches.slice(0, MAX_COILS)) branches.push({ label: b.label, pct: b.valve ? num({ q: { v: b.valve } }, 'v') : null, has: !!b.valve, sub: 'coil valve' });
      if (entry.reheat.length) {
        const vals = entry.reheat.map((/** @type {any} */ x) => num({ q: { v: x.valve } }, 'v')).filter((/** @type {any} */ v) => v !== null);
        const avg = vals.length ? vals.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) / vals.length : null;
        branches.push({ label: `VAV reheat ×${entry.reheat.length}`, pct: avg, has: true, sub: vals.length ? `avg · max ${fmt(Math.max(...vals), 0)}%` : 'no readings' });
      }
      if (entry.branches.length > MAX_COILS) parts.push(T(rightX - 70, 128, `+${entry.branches.length - MAX_COILS} more coils (see tooltip)`, 'op-t op-muted op-t-sm', 28));
      if (!branches.length) parts.push(T(300, 160, 'no loop valves in the model', 'op-t op-muted'));
      // Fixed slots: one 68-unit slot per branch, so boxes never overlap.
      branches.forEach((b, i) => {
        const x = 180 + 68 * i;
        parts.push(d.svg('line', { x1: x, y1: top, x2: x, y2: bottom, class: medCls }));
        parts.push(...valveSymbol(x, 96, b.has ? b.pct : null));
        parts.push(d.svg('rect', { x: x - 31, y: 140, width: 62, height: 56, rx: 4, class: 'op-box' }));
        parts.push(SG.label(x, 154, b.label, 10, { anchor: 'middle', cls: 'sg-t sg-sm sg-name', step: 11 }));
        parts.push(T(x, 184, b.sub, 'op-t op-muted op-t-sm', 12));
      });
      // DP sensor on the riser; readings sit to the left so they never cover the circle or the wire.
      const dpq = entry.q.dp;
      const dpTxt = r.dp === null ? 'DP n/a' : `DP ${fmt(r.dp / 1000)} kPa`;
      const spTxt = r.dpSp === null ? 'sp n/a' : `sp ${fmt(r.dpSp / 1000)} kPa`;
      parts.push(d.svg('line', { x1: rightX, y1: top, x2: rightX, y2: bottom, class: 'op-wire' }));
      parts.push(d.svg('circle', { cx: rightX, cy: 200, r: 11, class: 'op-node op-sensor' }));
      parts.push(T(rightX, 204, 'DP', 'op-t op-t-sm'));
      parts.push(T(rightX - 20, 198, dpTxt, r.dp === null ? 'op-t op-muted' : 'op-t', 16, 'end'));
      parts.push(T(rightX - 20, 212, spTxt, r.dpSp === null ? 'op-t op-muted' : 'op-t', 16, 'end'));
      if (dpq && dpq.found && dpq.remote) parts.push(T(rightX - 20, 184, `at ${dpq.equipId}`, 'op-t op-muted op-t-sm', 13, 'end'));
      return d.svg('svg', { viewBox: '0 0 560 290', class: 'op-svg', role: 'img', 'aria-label': `${entry.label} loop schematic` }, parts);
    }

    /** Air side schematic: fan with VFD, duct static pressure with its setpoint, airflow, VAV damper positions. */
    function fanSchematic(/** @type {any} */ entry, /** @type {any} */ r) {
      const parts = /** @type {any[]} */ ([]);
      const duct = 96;
      parts.push(d.svg('line', { x1: 20, y1: duct, x2: 500, y2: duct, class: 'op-duct' }));
      const fx = 90;
      parts.push(d.svg('circle', { cx: fx, cy: duct, r: 24, class: 'op-node' }));
      parts.push(d.svg('path', { d: `M ${fx - 8} ${duct - 10} L ${fx + 12} ${duct} L ${fx - 8} ${duct + 10} Z`, class: 'op-pump-arrow' }));
      parts.push(d.svg('rect', { x: fx - 20, y: duct - 66, width: 40, height: 20, rx: 3, class: 'op-box' }));
      parts.push(T(fx, duct - 52, 'VFD', 'op-t op-t-sm'));
      parts.push(d.svg('line', { x1: fx, y1: duct - 46, x2: fx, y2: duct - 24, class: 'op-wire' }));
      parts.push(T(fx, duct + 42, r.speed.hz === null ? 'speed n/a' : `${fmt(r.speed.hz)} Hz · ${pctText(r.speed.fraction === null ? null : r.speed.fraction * 100)}`, r.speed.known ? 'op-t' : 'op-t op-muted'));
      parts.push(T(fx, duct + 56, r.powerW === null ? 'kW n/a' : `${fmt(r.powerW / 1000, 2)} kW`, r.measuredPower !== null ? 'op-t' : 'op-t op-muted'));
      parts.push(T(fx, duct + 70, entry.label, 'op-t op-t-sm', 18));
      // Airflow and static pressure.
      parts.push(T(200, duct - 12, r.flow === null ? 'airflow n/a' : `${fmt(r.flow * 1000, 0)} L/s`, r.flow === null ? 'op-t op-muted' : 'op-t'));
      parts.push(d.svg('circle', { cx: 200, cy: duct, r: 9, class: 'op-node op-sensor' }));
      parts.push(T(200, duct + 4, 'F', 'op-t op-t-sm'));
      const sx = 262;
      parts.push(d.svg('line', { x1: sx, y1: duct, x2: sx, y2: duct + 30, class: 'op-wire' }));
      parts.push(d.svg('circle', { cx: sx, cy: duct + 38, r: 10, class: 'op-node op-sensor' }));
      parts.push(T(sx, duct + 42, 'P', 'op-t op-t-sm'));
      parts.push(T(sx, duct + 62, r.dp === null ? 'static n/a' : `${fmt(r.dp, 0)} Pa`, r.dp === null ? 'op-t op-muted' : 'op-t'));
      parts.push(T(sx, duct + 76, r.dpSp === null ? 'sp n/a' : `sp ${fmt(r.dpSp, 0)} Pa`, r.dpSp === null ? 'op-t op-muted' : 'op-t'));
      // VAV dampers.
      const shown = entry.terminals.slice(0, 7);
      shown.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
        const x = 320 + i * 29;
        const pct = t.damper.found ? num({ q: { v: t.damper } }, 'v') : null;
        parts.push(d.svg('line', { x1: x, y1: duct, x2: x, y2: 170, class: 'op-duct op-duct-thin' }));
        parts.push(d.svg('rect', { x: x - 11, y: 170, width: 22, height: 36, rx: 2, class: 'op-box' }));
        if (pct !== null) {
          const h = Math.max(0, Math.min(100, pct)) * 0.36;
          parts.push(d.svg('rect', { x: x - 11, y: 206 - h, width: 22, height: h, class: 'op-damper-fill' }));
        }
        parts.push(T(x, 220, pctText(pct), pct === null ? 'op-t op-muted op-t-sm' : 'op-t op-t-sm'));
        parts.push(T(x, 232, String(t.label).replace(/^VAV[- ]?/i, ''), 'op-t op-muted op-t-sm', 5));
      });
      if (entry.terminals.length > shown.length) parts.push(T(470, 190, `+${entry.terminals.length - shown.length} more`, 'op-t op-muted op-t-sm'));
      if (!entry.terminals.length) parts.push(T(400, 150, 'no VAVs assigned', 'op-t op-muted'));
      parts.push(T(400, 252, 'VAV damper position', 'op-t op-muted op-t-sm'));
      return d.svg('svg', { viewBox: '0 0 560 262', class: 'op-svg', role: 'img', 'aria-label': `${entry.label} air path schematic` }, parts);
    }

    /** One readout cell: a value, its imperial twin in parentheses, and where it came from. */
    function cell(/** @type {string} */ name, /** @type {string} */ value, /** @type {string} */ unit, /** @type {string} */ imp, /** @type {string} */ src) {
      return d.el('div', { class: 'op-cell' },
        d.el('div', { class: 'op-cell-name', text: name }),
        d.el('div', { class: 'op-cell-val' }, value, d.el('small', { text: unit })),
        d.el('div', { class: 'op-cell-sub', text: imp }),
        d.el('div', { class: `op-cell-src${src === 'measured' ? ' ok' : ''}`, text: src }));
    }

    function readout(/** @type {any} */ entry, /** @type {any} */ r) {
      const fan = entry.kind === 'fan';
      const norm = r.curve.normalized;
      const flowV = r.flow !== null ? r.flow : (r.op && !norm ? r.op.q : null);
      const flowSrc = r.flow !== null ? (r.flowSource === 'measured' ? 'measured' : r.flowSource) : (flowV !== null ? 'from curve ∩ system' : 'n/a');
      const imp = fan ? MATH.imperial.airFlow : MATH.imperial.waterFlow;
      const headV = r.op && !norm ? r.op.h : null;
      const head = headV === null ? null : (fan ? { value: headV, unit: 'Pa' } : { value: headV / 1000, unit: 'kPa' });
      const headImp = headV === null ? '' : (fan ? `(${fmt(MATH.imperial.airPressure(headV).value, 2)} in. w.c.)` : `(${fmt(MATH.imperial.waterHead(headV).value, 0)} ft)`);
      const flowImp = flowV === null ? '' : `(${fmt(imp(flowV).value, 0)} ${imp(flowV).unit})`;
      const pw = r.powerW === null ? null : r.powerW / 1000;
      const pwImp = r.powerW === null ? '' : `(${fmt(MATH.imperial.power(r.powerW).value, 2)} hp)`;
      const hzImp = r.speed.fraction === null ? '' : `(${fmt(r.speed.fraction * 100, 0)}% of rated speed)`;
      return d.el('div', { class: 'op-readout' },
        cell('Flow', flowV === null ? 'n/a' : fmt(flowV * 1000, fan ? 0 : 1), flowV === null ? '' : 'L/s', flowImp, flowSrc),
        cell(fan ? 'Total pressure' : 'Head', head === null ? 'n/a' : fmt(head.value, fan ? 0 : 1), head === null ? '' : head.unit, headImp, head === null ? (norm ? 'needs nameplate' : 'n/a') : 'from curve'),
        cell('Speed', r.speed.hz === null ? 'n/a' : fmt(r.speed.hz), r.speed.hz === null ? '' : 'Hz', hzImp, r.speed.known ? (r.speed.command ? 'command' : 'measured') : 'n/a'),
        cell('Power', pw === null ? 'n/a' : fmt(pw, 2), pw === null ? '' : 'kW', pwImp, r.powerSource || 'n/a'),
        cell(fan ? 'Duct static / setpoint' : 'Loop DP / setpoint',
          r.dp === null ? 'n/a' : fmt(fan ? r.dp : r.dp / 1000, fan ? 0 : 1),
          r.dp === null ? '' : (fan ? 'Pa' : 'kPa'),
          r.dpSp === null ? 'setpoint n/a' : `sp ${fmt(fan ? r.dpSp : r.dpSp / 1000, fan ? 0 : 1)} ${fan ? 'Pa' : 'kPa'}`,
          r.dp === null ? 'n/a' : 'measured'));
    }

    function comparison(/** @type {any} */ entry, /** @type {any} */ r) {
      if (!r.cmp) return d.el('p', { class: 'hint', text: 'Fixed speed against variable speed needs an operating point.' });
      if (r.curve.normalized) {
        return d.el('p', { class: 'hint', text: `Fixed speed against variable speed (illustrative): a fixed-speed ${entry.kind === 'fan' ? 'fan held to the same airflow by dampers' : 'pump held to the same flow by its control valves'} would draw about ${fmt(r.cmp.savedFraction * 100, 0)}% more power. Add design flow and ${entry.kind === 'fan' ? 'pressure' : 'head'} for real numbers.` });
      }
      const fan = entry.kind === 'fan';
      const rows = r.cmp.rows.map((/** @type {any} */ row) => d.el('tr', {},
        d.el('td', { text: row.label }),
        d.el('td', { class: 'num', text: `${fmt(row.q * 1000, fan ? 0 : 1)} L/s` }),
        d.el('td', { class: 'num', text: fan ? `${fmt(row.h, 0)} Pa` : `${fmt(row.h / 1000)} kPa` }),
        d.el('td', { class: 'num', text: `${fmt(row.s * 100, 0)}%` }),
        d.el('td', { class: 'num', text: `${fmt(row.powerW / 1000, 2)} kW` })));
      return d.el('div', { class: 'tablewrap' },
        d.el('table', { class: 'op-table' },
          d.el('thead', {}, d.el('tr', {}, ...['Case', 'Flow', fan ? 'Pressure' : 'Head', 'Speed', 'Power'].map((h) => d.el('th', { text: h })))),
          d.el('tbody', {}, rows)),
        d.el('p', { class: 'hint', text: `Throttling a fixed-speed ${fan ? 'fan' : 'pump'} to this flow costs ${fmt(r.cmp.savedW / 1000, 2)} kW (${fmt(r.cmp.savedFraction * 100, 0)}%) more than running the VFD at ${fmt((r.speed.fraction === null ? 1 : r.speed.fraction) * 100, 0)}% speed; the throttle burns ${fan ? `${fmt(r.cmp.throttleHead, 0)} Pa` : `${fmt(r.cmp.throttleHead / 1000)} kPa`}.` }));
    }

    function panel(/** @type {any} */ entry) {
      const r = OM.compute(entry, values);
      const missing = OM.missingText(entry);
      const fan = entry.kind === 'fan';
      const chartHost = d.el('div', { class: 'chart op-chart', role: 'img', 'aria-label': `${entry.label} ${fan ? 'fan' : 'pump'} curve and system curve` });
      const np = r.nameplate;
      const sourceNote = r.curveSource === 'coefficients' ? 'curve from the equipment curve coefficients'
        : r.curveSource === 'nameplate' ? `curve shape from the nameplate (design ${fmt(np.designFlow * 1000)} L/s at ${fan ? `${fmt(np.designHead, 0)} Pa` : `${fmt(np.designHead / 1000)} kPa`}), generic shape`
          : `no nameplate: add designFlow and ${fan ? 'designPressure' : 'designHead'} on ${entry.id} for real curves`;
      const card = d.el('section', { class: 'panel op-card', dataset: { opointId: entry.id } },
        d.el('h2', {},
          entry.label,
          d.el('span', { class: 'pill', text: fan ? 'supply fan' : `${entry.mediumLabel} pump` }),
          r.illustrative ? d.el('span', { class: 'pill op-warn', text: 'illustrative' }) : d.el('span', { class: 'pill ok', text: r.curveSource }),
          d.el('span', { class: 'hint', text: sourceNote })),
        missing ? d.el('p', { class: 'op-missing', text: missing }) : null,
        d.el('div', { class: 'op-grid' }, chartHost, d.el('div', { class: 'op-schematic' }, fan ? fanSchematic(entry, r) : pumpSchematic(entry, r))),
        readout(entry, r),
        comparison(entry, r),
        r.notes.length || (r.op && r.op.source) ? d.el('p', { class: 'hint', text: [r.op ? `Operating point: ${r.op.source}.` : 'No operating point: the curve cannot reach the static head at this speed.', `System curve: ${r.sys.source}.`, ...r.notes.map((/** @type {string} */ n) => `${n}.`)].join(' ') }) : null);
      return { card, chartHost, option: chartOption(entry, r) };
    }

    function section(/** @type {string} */ title, /** @type {string} */ hint, /** @type {any[]} */ entries, /** @type {string} */ empty) {
      const built = entries.map(panel);
      const wrap = d.el('div', { class: 'op-section' },
        d.el('h3', { class: 'op-h3' }, title, d.el('span', { class: 'hint', text: hint })),
        entries.length ? built.map((b) => b.card) : d.el('p', { class: 'hint', text: empty }));
      return { wrap, built };
    }

    function render() {
      if (!host || !resolved) return;
      const water = section('Waterside: chilled and hot water pumps', 'pump curve, system curve and operating point; loop members and live valve positions come from the model', resolved.pumps, 'No pumps in the model (equipment with the pump marker).');
      const air = section('Airside: air handler supply fans', 'fan curve, duct system curve and operating point; VAV damper positions downstream', resolved.fans, 'No air handlers in the model (equipment with the ahu marker).');
      d.fill(host, water.wrap, air.wrap);
      // Charts need laid-out hosts, so draw after they are in the page.
      for (const b of [...water.built, ...air.built]) {
        if (!d.chart(b.chartHost, b.option)) b.chartHost.textContent = 'ECharts is not loaded; the readouts below still show the operating point.';
      }
      if (statusEl) {
        const miss = [...resolved.pumps, ...resolved.fans].filter((/** @type {any} */ e) => e.missing.length).length;
        d.fill(statusEl,
          d.el('span', { class: 'pill', text: `${resolved.pumps.length} pump${resolved.pumps.length === 1 ? '' : 's'} · ${resolved.fans.length} air handler${resolved.fans.length === 1 ? '' : 's'}` }),
          d.el('span', { class: miss ? 'pill op-warn' : 'pill ok', text: miss ? `${miss} with missing data` : 'all points found' }),
          d.el('span', { class: 'hint', text: `SI units (L/s, kPa, Pa, kW); imperial in parentheses. ${o.demo ? 'Demo fixtures.' : 'Live NF values, read only.'}` }));
      }
    }

    async function load(/** @type {boolean} */ force) {
      if (busy) return;
      busy = true;
      try {
        if (!resolved || force || Date.now() - recordsAt > RECORDS_MS) {
          const records = await g.NfftModelSource.loadRecords(o.api.queryAll, idOf);
          resolved = OM.resolve(records, { vocab: g.NfftRoles223p, bind: g.NfftHaystackBind });
          recordsAt = Date.now();
        }
        const ids = [...new Set([...resolved.pumps, ...resolved.fans].flatMap((/** @type {any} */ e) => e.equipIds))];
        values = await g.NfftModelSource.loadValues(o.api.queryAll, { equipIds: ids });
        render();
      } catch (err) {
        if (statusEl) d.fill(statusEl, d.el('span', { class: 'pill bad', text: 'cannot read the model or values' }), d.el('span', { class: 'hint', text: String(err && /** @type {any} */ (err).message || err) }));
        o.notify(`Operating point: ${String(err && /** @type {any} */ (err).message || err)}`, true);
      } finally {
        busy = false;
      }
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = on ? setTimeout(async () => { await load(false); schedule(); }, POLL_MS) : null;
    }

    return {
      activate() {
        if (on) return;
        on = true;
        load(false).then(schedule);
      },
      deactivate() {
        on = false;
        if (timer) clearTimeout(timer);
        timer = null;
      },
      refresh() { return load(true); },
      /** For tests and the screenshot script. */
      state: () => ({ resolved, values }),
    };
  }

  g.NfftOperatingPointView = { mount, fmt };
})(globalThis);