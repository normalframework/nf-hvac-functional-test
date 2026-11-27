// "What the test touches": the plan, device by device. Built from the model's roles (223P-derived names,
// the same names Open-FDD uses), never from point names. Pure; the page and the tests use it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NfftTouchMap = factory();
})(globalThis, function () {
  'use strict';

  // Air path stages, upstream to downstream. A role lands on the first stage whose test matches.
  const STAGES = [
    { id: 'outdoor', label: 'Outdoor air', test: /^outdoor_air|outside_air/ },
    { id: 'return', label: 'Return / relief', test: /^return_|relief|exhaust/ },
    { id: 'mixing', label: 'Mixing box', test: /^mixed_air/ },
    { id: 'filter', label: 'Filter', test: /filter/ },
    { id: 'coils', label: 'Coils', test: /cooling_|heating_|preheat|coil/ },
    { id: 'fan', label: 'Supply fan', test: /fan|speed/ },
    { id: 'discharge', label: 'Discharge', test: /^discharge_|^supply_air|static_pressure/ },
    { id: 'safety', label: 'Safeties', test: /alarm|low_limit|smoke|freeze/ },
    { id: 'control', label: 'Controller', test: /mode|occupancy|enable/ },
  ];

  /**
   * @param {string} role
   * @param {string} type
   */
  function stageOf(role, type) {
    if (type === 'vav') return 'zones';
    for (const stage of STAGES) {
      if (stage.test.test(role)) return stage.id;
    }
    return 'control';
  }

  /**
   * @param {any} input { plan, steps, priority, lease_s, dry_run, equipment_types }
   */
  function build(input) {
    const plan = input && input.plan ? input.plan : { steps: [], sample_points: [] };
    const steps = Array.isArray(input && input.steps) ? input.steps : [];
    const types = (input && input.equipment_types) || {};
    const priority = input && Number.isInteger(input.priority) ? input.priority : 8;
    /** @type {Map<string, any>} */
    const devices = new Map();
    /**
     * @param {string} id
     */
    const device = (id) => {
      if (!devices.has(id)) {
        const type = types[id] || (id === plan.equipment_id ? 'ahu' : 'vav');
        devices.set(id, { equipment_id: id, type, points: new Map() });
      }
      return devices.get(id);
    };
    /**
     * @param {any} dev
     * @param {string} role
     */
    const point = (dev, role) => {
      if (!dev.points.has(role)) {
        dev.points.set(role, { role, stage: stageOf(role, dev.type), mode: 'read', writes: [] });
      }
      return dev.points.get(role);
    };
    for (const item of plan.sample_points || []) {
      if (item && item.equipment_id && item.role) point(device(item.equipment_id), item.role);
    }
    let elapsed = 0;
    steps.forEach((/** @type {any} */ step, /** @type {number} */ index) => {
      const hold = Number(step.hold_ms) || 0;
      for (const write of step.writes || []) {
        const target = device(write.equipment_id || plan.equipment_id);
        const p = point(target, write.role);
        p.mode = 'write';
        p.writes.push({
          step_n: index + 1,
          step_id: step.step_id,
          value: write.value,
          starts_after_ms: elapsed,
          hold_ms: hold,
          settle_ms: Number(step.settle_ms) || 0,
        });
      }
      elapsed += hold;
    });
    const release = { action: 'relinquish', priority, how: 'cancel the NF command; the slot reverts on lease expiry if the app stops' };
    const out = [...devices.values()].map((dev) => {
      const points = [...dev.points.values()].sort((a, b) => a.role.localeCompare(b.role));
      for (const p of points) {
        if (p.mode === 'write') p.release = release;
      }
      return {
        equipment_id: dev.equipment_id,
        type: dev.type,
        points,
        reads: points.filter((p) => p.mode === 'read').length,
        written: points.filter((p) => p.mode === 'write').length,
      };
    });
    out.sort((a, b) => (a.type === b.type ? a.equipment_id.localeCompare(b.equipment_id) : a.type === 'ahu' ? -1 : 1));
    const skipped = (plan.steps || []).filter((/** @type {any} */ s) => s.status === 'skipped')
      .map((/** @type {any} */ s) => ({ step_id: s.step_id, reason: s.skip_reason }));
    return {
      devices: out,
      stages: [...STAGES.map((s) => ({ id: s.id, label: s.label })), { id: 'zones', label: 'VAV zones' }],
      total_ms: elapsed,
      skipped,
      dry_run: input ? input.dry_run !== false : true,
      priority,
      lease_s: input && Number.isFinite(input.lease_s) ? input.lease_s : null,
    };
  }

  return { STAGES, stageOf, build };
});
