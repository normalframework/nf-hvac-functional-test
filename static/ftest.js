/**
 * Functional-test catalog: which tests a system supports, and how to evaluate them.
 * First built-in test is VAV max cooling airflow. Strategies come from NfftFtestStrategies.
 * Pass/fail is plain code. Browser global NfftFtest; CommonJS for tests and hooks.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      typeof require === 'function' ? require('./ftest-strategies.js') : root.NfftFtestStrategies,
    );
  } else /** @type {any} */ (root).NfftFtest = factory(root.NfftFtestStrategies);
})(typeof self !== 'undefined' ? self : this, function (Strategies) {
  'use strict';

  const DEFAULT_HOLD_MIN = 30;
  const HOLD_CHOICES = [15, 30, 60];
  const REACH = 0.9;

  /**
   * @param {any} unit discovered AHU (or system.unit)
   * @param {(unit: any) => any[]} [pointsFn]
   */
  function pointsOf(unit, pointsFn) {
    if (pointsFn) return pointsFn(unit);
    const out = [];
    const push = (/** @type {any} */ n, /** @type {string} */ equipment) => {
      for (const p of n.props || []) out.push({ ...p, equipment, part: n.id, part_label: n.label });
    };
    if (!unit) return out;
    push(unit, unit.id);
    for (const p of unit.parts || []) push(p, unit.id);
    for (const t of unit.terminals || []) {
      push(t, t.id);
      for (const p of t.parts || []) push(p, t.id);
    }
    return out;
  }

  /**
   * Shape a discovered terminal as the strategy resolver expects (points by role).
   * @param {any} terminal
   * @param {any[]} all
   */
  function boxOf(terminal, all) {
    /** @type {Record<string, any>} */
    const points = {};
    for (const p of all.filter((q) => q.equipment === terminal.id)) {
      if (p.role) points[p.role] = { ...p, writable: p.actuatable === true || p.writable === true };
    }
    return { id: terminal.id, label: terminal.label, type: 'vav', points, unassigned: false };
  }

  function ahuOf(unit, all) {
    /** @type {Record<string, any>} */
    const points = {};
    for (const p of all.filter((q) => q.equipment === unit.id)) {
      if (p.role) points[p.role] = { ...p, writable: p.actuatable === true || p.writable === true };
    }
    return { id: unit.id, label: unit.label, type: 'ahu', points };
  }

  const maxCooling = {
    id: 'vav.max_cool',
    name: 'VAV max cooling airflow',
    summary: 'Command every testable VAV to its cooling maximum, hold, then verify airflow and duct static.',
    durations: HOLD_CHOICES,
    defaultDuration: DEFAULT_HOLD_MIN,
    reach: REACH,
    /**
     * @param {any} unit
     * @param {{ points?: (u: any) => any[], config?: any }} [opts]
     */
    assess(unit, opts) {
      if (!unit || unit.unassigned) {
        return { test: this.id, ok: false, reason: 'unassigned', boxes: [], missing: ['a feed relationship to an air handler'] };
      }
      const all = pointsOf(unit, opts && opts.points);
      const ahu = ahuOf(unit, all);
      const boxes = (unit.terminals || []).map((/** @type {any} */ t) => {
        const box = boxOf(t, all);
        const resolved = Strategies.resolveBox(box, opts && opts.config, { ahu });
        const max = Strategies.pointOf(box, Strategies.FLOW_MAX);
        const targetHint = max && (max.value ?? max.latestValue);
        return {
          equipment_id: box.id,
          label: box.label,
          strategy: resolved.strategy,
          ok: resolved.ok,
          why: resolved.why,
          missing: resolved.missing || [],
          role: resolved.role,
          target: (targetHint !== undefined && targetHint !== null) ? Number(targetHint) : null,
          resolved,
        };
      });
      const testable = boxes.filter((b) => b.ok);
      const missingAhu = [];
      if (!Strategies.pointOf(ahu, 'discharge_air_static_pressure')) missingAhu.push('duct static pressure sensor');
      const fan = Strategies.pointOf(ahu, 'supply_fan_operating_status') || Strategies.pointOf(ahu, 'supply_fan_command');
      if (!fan) missingAhu.push('supply fan status or command');
      return {
        test: this.id,
        ok: testable.length > 0,
        reason: testable.length ? null : 'no_testable_boxes',
        boxes,
        testable: testable.length,
        total: boxes.length,
        missing: missingAhu,
        ahu: { id: ahu.id, label: ahu.label, missing: missingAhu },
      };
    },
    /**
     * Evaluate a hold snapshot. values is a map of role@equipment_id or point id to number.
     * @param {any} assessment from assess()
     * @param {{ values: Record<string, any>, staticPa?: number, staticSp?: number, fanSpeed?: number, fanOn?: boolean }} snap
     * @param {{ reach?: number, minStaticPa?: number }} [opts]
     */
    evaluate(assessment, snap, opts) {
      const reach = (opts && opts.reach) || REACH;
      const minStatic = (opts && opts.minStaticPa) || 40;
      const val = (/** @type {string} */ equip, /** @type {string} */ role) => {
        const v = snap.values[`${equip}:${role}`];
        if ((v !== undefined && v !== null) && v !== '') return Number(v);
        return null;
      };
      const results = (assessment.boxes || []).map((/** @type {any} */ box) => {
        if (!box.ok) {
          return { equipment_id: box.equipment_id, label: box.label, ok: false, skipped: true, reason: 'not_testable', missing: box.missing, deficiencies: [] };
        }
        const flow = val(box.equipment_id, Strategies.FLOW);
        const max = val(box.equipment_id, Strategies.FLOW_MAX);
        const target = ((box.target !== undefined && box.target !== null) && Number.isFinite(Number(box.target)) ? Number(box.target) : max);
        const damper = val(box.equipment_id, 'damper_position');
        const damperCmd = val(box.equipment_id, 'damper_position_command');
        /** @type {any[]} */
        const deficiencies = [];
        const ratio = target && target > 0 && (flow !== undefined && flow !== null) ? flow / target : null;
        const reached = (ratio !== undefined && ratio !== null) && ratio >= reach;
        if (flow === undefined || flow === null) deficiencies.push({ kind: 'missing_reading', message: 'No airflow reading at the end of the hold.' });
        else if (!reached) {
          deficiencies.push({
            kind: 'starved_box',
            message: `Airflow ${round(flow)} did not reach ${Math.round(reach * 100)}% of the ${round(target)} cooling maximum (${ratio !== undefined && ratio !== null ? Math.round(ratio * 100) : '—'}%).`,
          });
          if ((damper !== undefined && damper !== null && damper >= 95) || (damperCmd !== undefined && damperCmd !== null && damperCmd >= 95)) {
            deficiencies.push({ kind: 'damper_open_low_flow', message: `Damper is at ${round(damper !== undefined && damper !== null ? damper : damperCmd)}% but airflow is still low.` });
          }
        }
        return {
          equipment_id: box.equipment_id,
          label: box.label,
          ok: deficiencies.length === 0,
          skipped: false,
          strategy: box.strategy,
          flow,
          target,
          ratio,
          damper,
          deficiencies,
        };
      });
      /** @type {any[]} */
      const systemDeficiencies = [];
      const delivered = results.reduce((a, r) => a + (r.flow || 0), 0);
      const design = results.reduce((a, r) => a + (r.target || 0), 0);
      if (design > 0 && delivered < reach * design) {
        systemDeficiencies.push({ kind: 'total_volume', message: `Delivered ${round(delivered)} against ${round(design)} design volume (${Math.round((delivered / design) * 100)}%).` });
      }
      if ((snap.staticPa !== undefined && snap.staticPa !== null) && snap.staticPa < minStatic) {
        systemDeficiencies.push({ kind: 'static_not_maintained', message: `Duct static ${round(snap.staticPa)} Pa is below the ${minStatic} Pa floor.` });
      }
      if ((snap.staticSp !== undefined && snap.staticSp !== null) && (snap.staticPa !== undefined && snap.staticPa !== null) && snap.staticPa < 0.8 * snap.staticSp) {
        systemDeficiencies.push({ kind: 'static_not_maintained', message: `Duct static ${round(snap.staticPa)} Pa is below 80% of the ${round(snap.staticSp)} Pa setpoint.` });
      }
      if ((snap.fanSpeed !== undefined && snap.fanSpeed !== null) && snap.fanSpeed >= 99 && design > 0 && delivered < reach * design) {
        systemDeficiencies.push({ kind: 'fan_at_max', message: 'Supply fan is at 100% and still cannot deliver the design volume.' });
      }
      const tested = results.filter((r) => !r.skipped);
      const failed = tested.filter((r) => !r.ok);
      return {
        test: this.id,
        ok: failed.length === 0 && systemDeficiencies.length === 0 && tested.length > 0,
        results,
        systemDeficiencies,
        delivered,
        design,
      };
    },
  };

  const damperStroke = {
    id: 'vav.damper_stroke',
    name: 'Terminal damper stroke',
    summary: 'Stroke each terminal damper to closed, open and mid, and compare command with feedback.',
    assess(unit, opts) {
      if (!unit || unit.unassigned) {
        return { test: this.id, ok: false, reason: 'unassigned', boxes: [], missing: ['a feed relationship to an air handler'] };
      }
      const all = pointsOf(unit, opts && opts.points);
      const boxes = (unit.terminals || []).map((/** @type {any} */ t) => {
        const box = boxOf(t, all);
        const cmd = Strategies.pointOf(box, 'damper_position_command');
        const fb = Strategies.pointOf(box, 'damper_position');
        const missing = [];
        if (!cmd) missing.push('damper position command');
        else if (!Strategies.isWritable(cmd)) missing.push('damper position command is not writable');
        if (!fb) missing.push('damper position feedback');
        return {
          equipment_id: box.id,
          label: box.label,
          strategy: missing.length ? 'unsupported' : 'damper_stroke',
          ok: missing.length === 0,
          why: missing.length ? null : 'This box has a damper command and damper feedback.',
          missing,
        };
      });
      return { test: this.id, ok: boxes.some((b) => b.ok), boxes, testable: boxes.filter((b) => b.ok).length, total: boxes.length, missing: [] };
    },
  };

  const TESTS = [maxCooling, damperStroke];

  /**
   * @param {any} unit
   * @param {{ points?: (u: any) => any[], config?: any, unassigned?: boolean }} [opts]
   */
  function assessSystem(unit, opts) {
    const unassigned = !unit || unit.unassigned || (opts && opts.unassigned);
    const tests = TESTS.map((t) => t.assess(unassigned ? { unassigned: true, terminals: [], id: unit && unit.id, label: unit && unit.label } : unit, opts));
    return {
      equipment_id: unit && unit.id,
      label: unit && (unit.label || unit.id),
      unassigned: Boolean(unassigned),
      tests,
      testable: !unassigned && tests.some((t) => t.ok),
    };
  }

  const round = (/** @type {number} */ x, d = 1) => { const f = 10 ** d; return Math.round(x * f) / f; };

  return {
    TESTS,
    HOLD_CHOICES,
    DEFAULT_HOLD_MIN,
    REACH,
    maxCooling,
    damperStroke,
    assessSystem,
    pointsOf,
    boxOf,
    ahuOf,
  };
});
