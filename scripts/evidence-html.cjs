'use strict';
/* eslint-env node */
/* global process */
// Standalone evidence report (HTML, inline SVG, no scripts) from an nfft-evidence/1 report object.

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tz = process.env.NFFT_REPORT_TZ || 'America/Chicago';
const when = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }) : '');
const pill = (s) => `<span class="pill ${esc(s)}">${esc(String(s).replace('_', ' ').toUpperCase())}</span>`;
const COLORS = ['#7c7cff', '#22a06b', '#e5793b', '#d6457a', '#2d8fd5', '#8a6d3b'];

/** Line chart of several series over time. series: [{ label, unit, points: [[t, v]] }] */
function lineChart(title, series, opts = {}) {
  const W = 760; const H = 220; const L = 52; const R = 16; const T = 26; const B = 30;
  const all = series.flatMap((s) => s.points);
  if (!all.length) return `<p class="muted">${esc(title)}: no samples.</p>`;
  const t0 = Math.min(...all.map((p) => p[0])); const t1 = Math.max(...all.map((p) => p[0])) || t0 + 1;
  let lo = Math.min(...all.map((p) => p[1])); let hi = Math.max(...all.map((p) => p[1]));
  if (opts.min !== undefined) lo = Math.min(lo, opts.min);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = lo + f * (hi - lo); return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v.toFixed(Math.abs(hi - lo) < 10 ? 1 : 0)}</text>`; }).join('');
  const shade = (opts.bands || []).map((b) => `<rect x="${x(b.from)}" y="${T}" width="${Math.max(0, x(b.to) - x(b.from))}" height="${H - T - B}" class="band"/><text x="${x(b.from) + 4}" y="${T + 12}" class="ax">${esc(b.label)}</text>`).join('');
  const lines = series.map((s, i) => `<polyline fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="2" points="${s.points.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')}"/>`).join('');
  const legend = series.map((s, i) => `<span class="lg"><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(s.label)}${s.unit ? ` (${esc(s.unit)})` : ''}</span>`).join('');
  const ticks = [0, 0.5, 1].map((f) => { const t = t0 + f * (t1 - t0); return `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" class="ax">${esc(new Date(t).toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }))}</text>`; }).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img">${shade}${grid}${lines}${ticks}</svg><div class="legend">${legend}</div></figure>`;
}

function fanChart(op) {
  if (!op || !op.curve) return '';
  const W = 760; const H = 260; const L = 56; const R = 16; const T = 20; const B = 34;
  const qMax = Math.max(...op.curve.map((p) => p.q)); const pMax = Math.max(...op.curve.map((p) => p.full));
  const x = (q) => L + (q / qMax) * (W - L - R); const y = (p) => T + (1 - p / pMax) * (H - T - B);
  const full = op.curve.map((p) => `${x(p.q).toFixed(1)},${y(p.full).toFixed(1)}`).join(' ');
  const now = op.curve.map((p) => `${x(p.q).toFixed(1)},${y(p.now).toFixed(1)}`).join(' ');
  const design = op.design_flow_m3s ? `<circle cx="${x(op.design_flow_m3s)}" cy="${y(op.design_pressure_pa)}" r="5" class="dz"/><text x="${x(op.design_flow_m3s) + 8}" y="${y(op.design_pressure_pa) - 8}" class="ax">design ${op.design_flow_m3s} m³/s @ ${op.design_pressure_pa} Pa</text>` : '';
  const axes = [0, 0.5, 1].map((f) => `<text x="${x(f * qMax)}" y="${H - 10}" text-anchor="middle" class="ax">${(f * qMax).toFixed(1)} m³/s</text><text x="${L - 6}" y="${y(f * pMax) + 4}" text-anchor="end" class="ax">${(f * pMax).toFixed(0)}</text>`).join('');
  return `<figure><figcaption>Supply fan operating point during max cooling (fan pressure, Pa, against airflow; airflow is the sum of the box flows, this unit has no airflow station). Curve source: ${esc(op.source)}</figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img"><polyline fill="none" stroke="#9aa0b4" stroke-width="2" stroke-dasharray="6 4" points="${full}"/><polyline fill="none" stroke="#7c7cff" stroke-width="2.5" points="${now}"/>${design}<circle cx="${x(op.flow_m3s)}" cy="${y(op.pressure_pa)}" r="7" class="op"/><text x="${x(op.flow_m3s) + 10}" y="${y(op.pressure_pa) + 18}" class="ax">operating ${op.flow_m3s} m³/s @ ${op.pressure_pa} Pa, ${op.speed_pct}% speed${op.power_kw ? `, ~${op.power_kw} kW` : ''}</text>${axes}</svg>
<div class="legend"><span class="lg"><i style="background:#9aa0b4"></i>100% speed</span><span class="lg"><i style="background:#7c7cff"></i>${esc(op.speed_pct)}% speed</span></div></figure>`;
}

function series(samples, key, label, unit, scale = 1) {
  return { label, unit, points: samples.filter((s) => s.v[key] !== null && s.v[key] !== undefined).map((s) => [s.t, Number(s.v[key]) * scale]) };
}

function sequenceHtml(seq, samples) {
  const ahu = Object.keys((samples[0] || { v: {} }).v).find((k) => k.endsWith(':return_air_temperature'));
  const a = ahu ? ahu.split(':')[0] : 'rtu_1';
  const band = [{ from: Date.parse(seq.hold_window.from), to: Date.parse(seq.hold_window.to), label: 'checked window' }];
  let charts = '';
  if (seq.test_id === 'ahu.recirc') {
    charts = lineChart('Air temperatures', [series(samples, `${a}:return_air_temperature`, 'RAT', '°C'), series(samples, `${a}:mixed_air_temperature`, 'MAT', '°C'), series(samples, `${a}:discharge_air_temperature`, 'DAT', '°C'), series(samples, `${a}:outdoor_air_intake_temperature`, 'OAT', '°C')], { bands: band })
      + lineChart('Outdoor and return air dampers', [series(samples, `${a}:outdoor_air_intake_damper_position`, 'OA damper', '%'), series(samples, `${a}:return_damper_position`, 'RA damper', '%')], { bands: band, min: 0 });
  } else {
    const flowSum = { label: 'Sum of box airflow', unit: 'm³/s', points: samples.map((s) => [s.t, Object.entries(s.v).filter(([k]) => k.endsWith(':discharge_air_volume_flow_rate')).reduce((t, [, v]) => t + (Number(v) || 0), 0) / 1000]) };
    charts = lineChart('Duct static pressure', [series(samples, `${a}:discharge_air_static_pressure`, 'Static', 'Pa'), series(samples, `${a}:discharge_air_static_pressure_setpoint`, 'Setpoint', 'Pa')], { bands: band, min: 0 })
      + lineChart('Supply fan speed', [series(samples, `${a}:supply_fan_speed_feedback`, 'Speed', '%')], { bands: band, min: 0 })
      + lineChart('Airflow', [flowSum], { bands: band, min: 0 })
      + fanChart(seq.operating_point);
  }
  const checks = seq.checks.map((c) => `<tr><td>${pill(c.status)}</td><td>${esc(c.label)}</td><td>${esc(c.detail)}</td></tr>`).join('');
  const phases = seq.phases.map((p) => `<tr><td>${esc(when(p.t))}</td><td>${esc(p.phase)}</td><td>${esc(p.step)}</td><td>${esc(p.reason)}</td></tr>`).join('');
  const boxes = (seq.boxes || []).map((b) => `<tr><td>${esc(b.id)}</td><td>${esc(b.strategy)}</td><td>${b.tested ? 'yes' : esc(b.reason || 'no')}</td><td>${esc(b.flow_lps)}</td><td>${esc(b.max_lps)}</td><td>${b.ratio === null ? '' : `${Math.round(b.ratio * 100)}%`}</td><td>${b.pass === null ? '—' : pill(b.pass ? 'pass' : 'fail')}</td></tr>`).join('');
  const strat = seq.strategies ? Object.entries(seq.strategies).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') : '';
  return `<section class="seq"><h2>${esc(seq.test_id)} ${pill(seq.verdict)}</h2>
<p class="muted">Run ${esc(seq.run_id)} · ${esc(when(seq.started_at))} to ${esc(when(seq.ended_at))} · hold ${seq.hold_minutes} min after ${seq.settle_minutes} min settle · checked ${seq.hold_window.samples} one-minute samples</p>
<table><thead><tr><th>Result</th><th>Check</th><th>Evidence</th></tr></thead><tbody>${checks}</tbody></table>
${charts}
${boxes ? `<h3>Per-box strategy and result</h3><p class="muted">${strat}</p><table><thead><tr><th>Box</th><th>Strategy</th><th>Tested</th><th>Flow L/s</th><th>Max L/s</th><th>Reached</th><th>Result</th></tr></thead><tbody>${boxes}</tbody></table>` : ''}
<details><summary>State timeline</summary><table><thead><tr><th>Time</th><th>Phase</th><th>Step</th><th>Reason</th></tr></thead><tbody>${phases}</tbody></table></details></section>`;
}

function renderHtml(report) {
  const seqs = report.sequences.map((s) => sequenceHtml(s, (report.trends || {})[s.test_id] || [])).join('');
  const o = report.openfdd || {};
  const ofdd = o.app ? `<table><thead><tr><th>Hook</th><th>Runs during test</th><th>States</th><th>Last</th></tr></thead><tbody>${o.hooks.map((h) => `<tr><td>${esc(h.hook)}</td><td>${h.runs_in_window}</td><td>${esc(h.states.join(', '))}</td><td>${esc(h.last_state)}</td></tr>`).join('')}</tbody></table><p>${o.fdd_fresh} of ${o.fdd_rows} FDD result rows on the sim equipment were refreshed during the test, on ${o.equipment_with_fdd} pieces of equipment.</p>` : '<p class="muted">No Open-FDD app installed on this NF.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>nfft evidence ${esc(report.generated_at)}</title><style>
body{font:14px/1.45 system-ui,Segoe UI,sans-serif;margin:0;background:#f4f5f9;color:#1d2433}main{max-width:900px;margin:0 auto;padding:24px}
header,.seq,.card{background:#fff;border:1px solid #e3e6ee;border-radius:10px;padding:16px 20px;margin-bottom:16px}
h1{margin:0 0 6px;font-size:22px}h2{font-size:18px;margin:0 0 6px}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border-bottom:1px solid #eceef4;padding:5px 8px;text-align:left;vertical-align:top}
.muted{color:#6b7385}.pill{display:inline-block;border-radius:999px;padding:1px 9px;font-size:11px;font-weight:700;color:#fff;background:#9aa0b4}.pill.pass{background:#22a06b}.pill.fail{background:#d6457a}
svg{width:100%;height:auto;background:#fbfbfe;border:1px solid #eceef4;border-radius:8px}.g{stroke:#e8eaf2}.ax{font-size:11px;fill:#6b7385}.band{fill:#7c7cff;opacity:.08}.op{fill:#e5793b}.dz{fill:#22a06b}
figure{margin:12px 0}figcaption{font-weight:600;margin-bottom:4px}.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-top:4px}.lg i{display:inline-block;width:12px;height:3px;margin-right:5px;vertical-align:middle}
.kv{display:grid;grid-template-columns:180px 1fr;gap:2px 12px}</style></head><body><main>
<header><h1>Functional test evidence ${pill(report.verdict)}</h1><div class="kv">
<span class="muted">Target</span><span>${esc(report.target)} (${esc(report.nf)})</span>
<span class="muted">Building</span><span>${esc(report.building)}</span>
<span class="muted">Generated</span><span>${esc(when(report.generated_at))}</span>
<span class="muted">Plan fingerprint</span><span><code>${esc(report.plan_hash)}</code></span>
<span class="muted">Bound points</span><span>${esc(report.bound_points)}</span>
<span class="muted">Sim step / physics</span><span>${esc(report.sim_step)}; ${esc(report.physics)}</span></div>
<p class="muted">A live run of this plan is allowed only after a passed simulation run with the same fingerprint has been signed off. Live keeps every interlock, priority check and the dry-run default.</p></header>
${seqs}
<section class="card"><h2>Open-FDD app on the same model</h2>${ofdd}</section>
</main></body></html>
`;
}

module.exports = { renderHtml, lineChart, fanChart };
