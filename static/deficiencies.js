/**
 * Deficiency detection for the functional test graphic. Pure rules over live or recorded values.
 * Browser global NfftDeficiencies; CommonJS for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftDeficiencies = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FEEDBACK = {
    outdoor_air_intake_damper_position_command: 'outdoor_air_intake_damper_position',
    return_damper_position_command: 'return_damper_position',
    cooling_valve_position_command: 'cooling_valve_position',
    heating_valve_position_command: 'heating_valve_position',
    damper_position_command: 'damper_position',
    terminal_unit_heating_valve_position_command: null,
  };

  const RANGES = {
    default: { lo: null, hi: null },
    percent: { lo: -1, hi: 101 },
    temperature: { lo: -40, hi: 80 },
    pressure: { lo: -200, hi: 2500 },
    flow: { lo: -1, hi: 1e6 },
  };

  /**
   * @param {string} role
   */
  function rangeFor(role) {
    if (/temperature|temp/.test(role)) return RANGES.temperature;
    if (/pressure/.test(role)) return RANGES.pressure;
    if (/volume_flow|flow/.test(role)) return RANGES.flow;
    if (/position|speed|humidity/.test(role)) return RANGES.percent;
    return RANGES.default;
  }

  /**
   * @param {any[]} points flattened points (role, id, equipment, part, label)
   * @param {Record<string, any>} values map of point id -> number | { value, ts }
   * @param {{ now?: number, staleAfterMs?: number, tolerance?: number, failedSteps?: any[] }} [opts]
   */
  function detect(points, values, opts) {
    const now = (opts && opts.now) || Date.now();
    const staleAfter = (opts && opts.staleAfterMs) || 15 * 60 * 1000;
    const tolerance = (opts && opts.tolerance) || 5;
    /** @type {any[]} */
    const out = [];
    const reading = (/** @type {any} */ id) => {
      const v = values[id];
      if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v.value, ts: v.ts };
      return { value: v, ts: null };
    };
    const byEquipRole = new Map();
    for (const p of points || []) {
      if (p.role) byEquipRole.set(`${p.equipment}:${p.role}`, p);
    }
    for (const p of points || []) {
      const r = reading(p.id);
      if ((r.ts !== undefined && r.ts !== null) && Number.isFinite(Number(r.ts)) && now - Number(r.ts) > staleAfter) {
        out.push(item(p, 'stale', `Point has not updated in ${Math.round((now - Number(r.ts)) / 60000)} min.`));
      }
      if ((r.value !== undefined && r.value !== null) && r.value !== '' && Number.isFinite(Number(r.value))) {
        const range = rangeFor(p.role || '');
        const n = Number(r.value);
        if ((range.lo !== undefined && range.lo !== null) && n < range.lo) out.push(item(p, 'out_of_range', `Value ${n} is below the expected range.`));
        if ((range.hi !== undefined && range.hi !== null) && n > range.hi) out.push(item(p, 'out_of_range', `Value ${n} is above the expected range.`));
      }
      const fbRole = p.role ? FEEDBACK[p.role] : null;
      if (fbRole) {
        const fb = byEquipRole.get(`${p.equipment}:${fbRole}`);
        if (fb) {
          const cmd = reading(p.id).value;
          const pos = reading(fb.id).value;
          if ((cmd !== undefined && cmd !== null) && (pos !== undefined && pos !== null) && Number.isFinite(Number(cmd)) && Number.isFinite(Number(pos))
            && Math.abs(Number(cmd) - Number(pos)) > tolerance) {
            out.push(item(p, 'command_feedback_mismatch', `Command ${Number(cmd)}% vs feedback ${Number(pos)}% (tolerance ${tolerance}%).`, fb.part || p.part));
          }
        }
      }
    }
    for (const step of (opts && opts.failedSteps) || []) {
      const p = points.find((q) => q.equipment === step.equipment_id && (q.role === step.role || q.id === step.point_id)) || points.find((q) => q.equipment === step.equipment_id);
      out.push({
        id: `failed_step:${step.step_id || step.equipment_id}`,
        kind: step.kind || 'failed_step',
        equipment_id: step.equipment_id,
        part: (p && (p.part || p.id)) || step.part || null,
        point_id: p ? p.id : null,
        label: step.label || (p && p.label) || step.equipment_id,
        message: step.message || step.explanation || 'Failed test step.',
        severity: 'fail',
      });
    }
    return out;
  }

  function item(p, kind, message, part) {
    return {
      id: `${kind}:${p.id}`,
      kind,
      equipment_id: p.equipment,
      part: part || p.part || null,
      point_id: p.id,
      role: p.role,
      label: p.label || p.part_label || p.id,
      message,
      severity: kind === 'stale' ? 'warn' : 'fail',
    };
  }

  return { detect, rangeFor, FEEDBACK };
});
