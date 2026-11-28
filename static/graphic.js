/**
 * Functional test graphic simulation and functional-test playback, driven only by a discovered 223P unit
 * (NfftS223.discover). Nothing here names equipment or points: every input, output and test step is found
 * by its Open-FDD role on the model. The model is deterministic (no randomness, no wall clock), so a run
 * replays the same frames every time. Pass/fail, limits, interlocks, timeouts and release are plain code.
 *
 * Browser global NfftGraphic; CommonJS for tests. The sim is used only behind ?demo=1. Live values are applied with liveFrame and never written here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else /** @type {any} */ (root).NfftGraphic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Roles the sim accepts as inputs, with their resting (automatic) value. */
  const INPUTS = {
    supply_fan_command: { auto: 1, min: 0, max: 1, step: 1, rate: Infinity },
    supply_fan_speed_command: { auto: 70, min: 0, max: 100, step: 1, rate: 5 },
    outdoor_air_intake_damper_position_command: { auto: 30, min: 0, max: 100, step: 1, rate: 2 },
    return_damper_position_command: { auto: 70, min: 0, max: 100, step: 1, rate: 2 },
    cooling_valve_position_command: { auto: 40, min: 0, max: 100, step: 1, rate: 2 },
    heating_valve_position_command: { auto: 0, min: 0, max: 100, step: 1, rate: 2 },
    damper_position_command: { auto: 50, min: 0, max: 100, step: 1, rate: 1.5 },
    terminal_unit_heating_valve_position_command: { auto: 0, min: 0, max: 100, step: 1, rate: 2 },
  };
  /** Feedback role for each positional command role. */
  const FEEDBACK = {
    outdoor_air_intake_damper_position_command: 'outdoor_air_intake_damper_position',
    return_damper_position_command: 'return_damper_position',
    cooling_valve_position_command: 'cooling_valve_position',
    heating_valve_position_command: 'heating_valve_position',
    damper_position_command: 'damper_position',
  };
  const ENV = { oat: 31, rat: 24, zoneDrift: 26, designPa: 250, shutoffPa: 1000, defaultMaxLps: 300 };

  const clamp = (/** @type {number} */ x, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, x));
  const round = (/** @type {number} */ x, /** @type {number} */ d = 1) => { const f = 10 ** d; return Math.round(x * f) / f; };
  /** Installed damper characteristic, 0..1 open to flow coefficient. */
  const flowCoefficient = (/** @type {number} */ pct) => Math.max(0.02, (clamp(pct, 0, 100) / 100) ** 1.5);

  /**
   * Parse a fault spec "kind:value" (stuck, linkage, feedback_scale).
   * @param {string} spec
   */
  function parseFault(spec) {
    const m = /^\s*(stuck|linkage|feedback_scale)\s*:\s*([0-9.]+)\s*$/.exec(String(spec || ''));
    if (!m) return null;
    return { kind: m[1], value: Number(m[2]) };
  }

  /**
   * Index a discovered unit by role. Returns the actuators, observables and terminals the sim and the test use.
   * @param {any} unit one entry of discover().ahus
   * @param {(unit: any) => any[]} points NfftS223.points
   * @param {Record<string, any>} [values] latest values by point id (limits the model itself does not carry)
   */
  function bind(unit, points, values = {}) {
    const positive = (/** @type {any} */ v) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const all = points(unit);
    /** @param {string} equipment @param {string} role */
    const find = (equipment, role) => all.find((p) => p.equipment === equipment && p.role === role) || null;
    const inputs = all.filter((p) => p.actuatable && Object.prototype.hasOwnProperty.call(INPUTS, p.role));
    const terminals = unit.terminals.map((/** @type {any} */ t) => {
      const max = find(t.id, 'discharge_air_volume_flow_rate_maximum');
      const cmd = find(t.id, 'damper_position_command');
      return {
        id: t.id,
        label: t.label,
        zone: t.zone ? t.zone.label : null,
        damperPart: cmd ? cmd.part : null,
        cmd,
        pos: find(t.id, 'damper_position'),
        flow: find(t.id, 'discharge_air_volume_flow_rate'),
        dat: find(t.id, 'terminal_unit_discharge_air_temperature'),
        reheat: find(t.id, 'terminal_unit_heating_valve_position_command'),
        zoneTemp: find(t.id, 'zone_air_temperature'),
        maxLps: positive(max && max.value) || positive(max && values[max.id]) || ENV.defaultMaxLps,
      };
    });
    const ahu = {};
    for (const role of ['supply_fan_command', 'supply_fan_speed_command', 'supply_fan_operating_status', 'outdoor_air_intake_damper_position_command',
      'return_damper_position_command', 'cooling_valve_position_command', 'heating_valve_position_command', 'discharge_air_temperature',
      'mixed_air_temperature', 'outdoor_air_intake_temperature', 'return_air_temperature', 'discharge_air_static_pressure', 'filter_air_pressure_delta',
      'outdoor_air_intake_damper_position', 'return_damper_position', 'cooling_valve_position', 'heating_valve_position']) {
      /** @type {any} */ (ahu)[role] = find(unit.id, role);
    }
    return { all, inputs, terminals, ahu: /** @type {Record<string, any>} */ (ahu) };
  }

  /**
   * Create a simulation for a discovered unit.
   * @param {any} unit
   * @param {{ points: (unit: any) => any[], faults?: Record<string, string>, values?: Record<string, any> }} opts
   *   faults maps a damper part id to a spec ("stuck:38").
   */
  function createSim(unit, opts) {
    const b = bind(unit, opts.points, opts.values || {});
    /** @type {Record<string, number>} input id -> commanded value */
    const command = {};
    /** @type {Record<string, number>} input id -> actuator position (what the motor did) */
    const actuator = {};
    for (const p of b.inputs) {
      const spec = /** @type {any} */ (INPUTS)[p.role];
      command[p.id] = spec.auto;
      actuator[p.id] = spec.auto;
    }
    /** @type {Record<string, { kind: string, value: number }>} */
    const faults = {};
    for (const [part, spec] of Object.entries(opts.faults || {})) {
      const f = parseFault(spec);
      if (f) faults[part] = f;
    }
    const kDesign = b.terminals.map((t) => t.maxLps / Math.sqrt(ENV.designPa));
    const kOpen = kDesign.reduce((a, k) => a + k, 0) || 1;
    // Fan curve P = P0 s^2 - a Q^2, sized so every terminal fully open at full speed sits at design pressure.
    const curveA = (ENV.shutoffPa / ENV.designPa - 1) / (kOpen * kOpen);
    const state = {
      t: 0,
      fanSpeed: 0,
      sat: ENV.rat,
      tDat: b.terminals.map(() => ENV.rat),
      tZone: b.terminals.map((_, i) => 23 + i * 0.4),
    };
    const byRole = (/** @type {string} */ role, /** @type {string} */ equipment) => b.inputs.find((p) => p.role === role && p.equipment === equipment);
    const inputValue = (/** @type {any} */ p, /** @type {number} */ fallback) => (p ? actuator[p.id] : fallback);

    /** Blade position for a terminal damper after any fault. */
    function blade(/** @type {any} */ t) {
      const a = t.cmd ? actuator[t.cmd.id] : 100;
      const f = t.damperPart ? faults[t.damperPart] : null;
      if (f && f.kind === 'stuck') return Math.min(a, f.value);
      if (f && f.kind === 'linkage') return f.value;
      return a;
    }
    /** Feedback the controller reads for a terminal damper. */
    function feedback(/** @type {any} */ t) {
      const f = t.damperPart ? faults[t.damperPart] : null;
      const a = t.cmd ? actuator[t.cmd.id] : 100;
      if (f && f.kind === 'stuck') return Math.min(a, f.value);
      if (f && f.kind === 'feedback_scale') return a * f.value;
      return a;
    }

    function solve() {
      const fanOn = inputValue(byRole('supply_fan_command', unit.id), 1) >= 0.5;
      const s = fanOn ? state.fanSpeed / 100 : 0;
      const oa = inputValue(byRole('outdoor_air_intake_damper_position_command', unit.id), 30);
      const ra = inputValue(byRole('return_damper_position_command', unit.id), 70);
      const intake = 0.55 + 0.45 * Math.max(oa, ra) / 100;
      const blades = b.terminals.map(blade);
      const kSys = b.terminals.reduce((acc, _, i) => acc + kDesign[i] * flowCoefficient(blades[i]), 0);
      const pressure = (ENV.shutoffPa * intake * s * s) / (1 + curveA * kSys * kSys);
      const flows = b.terminals.map((_, i) => kDesign[i] * flowCoefficient(blades[i]) * Math.sqrt(pressure));
      const total = flows.reduce((a, q) => a + q, 0);
      const oaFrac = oa + ra > 0 ? oa / (oa + ra) : 0;
      const mat = oaFrac * ENV.oat + (1 - oaFrac) * ENV.rat;
      const clg = inputValue(byRole('cooling_valve_position_command', unit.id), 0);
      const htg = inputValue(byRole('heating_valve_position_command', unit.id), 0);
      const satTarget = s > 0 ? mat - 14 * clg / 100 + 20 * htg / 100 + 0.8 * s : ENV.rat;
      return { fanOn, s, oa, ra, oaFrac, blades, pressure, flows, total, mat, clg, htg, satTarget };
    }

    /** Advance the model by dt seconds. */
    function step(/** @type {number} */ dt) {
      for (const p of b.inputs) {
        const spec = /** @type {any} */ (INPUTS)[p.role];
        const d = command[p.id] - actuator[p.id];
        const max = spec.rate * dt;
        actuator[p.id] = Math.abs(d) <= max ? command[p.id] : actuator[p.id] + Math.sign(d) * max;
      }
      const speedCmd = inputValue(byRole('supply_fan_speed_command', unit.id), 70);
      state.fanSpeed = speedCmd;
      const x = solve();
      state.sat += (x.satTarget - state.sat) * (1 - Math.exp(-dt / 30));
      b.terminals.forEach((t, i) => {
        const rh = t.reheat ? actuator[t.reheat.id] : 0;
        const target = state.sat + 15 * rh / 100;
        state.tDat[i] += (target - state.tDat[i]) * (1 - Math.exp(-dt / 20));
        const share = x.flows[i] / t.maxLps;
        state.tZone[i] += ((ENV.zoneDrift - state.tZone[i]) / 1800 + share * (state.tDat[i] - state.tZone[i]) / 600) * dt;
      });
      state.t += dt;
      return read();
    }

    /** Every observable value by property id, plus the scene internals. */
    function read() {
      const x = solve();
      /** @type {Record<string, number|boolean>} */
      const values = {};
      for (const p of b.inputs) values[p.id] = round(command[p.id]);
      const set = (/** @type {any} */ p, /** @type {number|boolean} */ v) => { if (p) values[p.id] = typeof v === 'number' ? round(v) : v; };
      set(b.ahu.supply_fan_operating_status, x.fanOn && state.fanSpeed > 5);
      set(b.ahu.discharge_air_temperature, state.sat);
      set(b.ahu.mixed_air_temperature, x.mat);
      set(b.ahu.outdoor_air_intake_temperature, ENV.oat);
      set(b.ahu.return_air_temperature, ENV.rat);
      set(b.ahu.discharge_air_static_pressure, x.pressure);
      set(b.ahu.filter_air_pressure_delta, 60 * (x.total / kOpen / Math.sqrt(ENV.designPa)) ** 2);
      for (const p of b.inputs) {
        const fb = /** @type {any} */ (FEEDBACK)[p.role];
        if (!fb || p.role === 'damper_position_command') continue;
        const out = b.all.find((q) => q.equipment === p.equipment && q.role === fb);
        set(out, actuator[p.id]);
      }
      b.terminals.forEach((t, i) => {
        set(t.pos, feedback(t));
        set(t.flow, x.flows[i]);
        set(t.dat, state.tDat[i]);
        set(t.zoneTemp, state.tZone[i]);
      });
      return {
        t: state.t,
        values,
        scene: {
          fanOn: x.fanOn,
          fanSpeed: round(state.fanSpeed),
          staticPa: round(x.pressure),
          totalLps: round(x.total),
          oaFraction: round(x.oaFrac, 3),
          sat: round(state.sat, 2),
          mat: round(x.mat, 2),
          cooling: round(x.clg),
          heating: round(x.htg),
          outdoorDamper: round(x.oa),
          returnDamper: round(x.ra),
          terminals: b.terminals.map((t, i) => ({
            id: t.id,
            blade: round(x.blades[i]),
            feedback: round(feedback(t)),
            command: t.cmd ? round(command[t.cmd.id]) : null,
            flowLps: round(x.flows[i]),
            maxLps: t.maxLps,
            reheat: t.reheat ? round(actuator[t.reheat.id]) : 0,
            dat: round(state.tDat[i], 2),
            zoneTemp: round(state.tZone[i], 2),
          })),
        },
      };
    }

    /** Settle the model at its current commands (used before interaction and before a test). */
    function settle(/** @type {number} */ seconds = 600) {
      for (let i = 0; i < seconds; i += 1) step(1);
      return read();
    }

    return {
      binding: b,
      inputs: b.inputs.map((p) => ({ ...p, ...(/** @type {any} */ (INPUTS)[p.role]) })),
      faults,
      set(/** @type {string} */ id, /** @type {number} */ value) {
        const p = b.inputs.find((q) => q.id === id);
        if (!p) throw new Error(`not a simulated input: ${id}`);
        const spec = /** @type {any} */ (INPUTS)[p.role];
        command[id] = clamp(Number(value), spec.min, spec.max);
      },
      get: (/** @type {string} */ id) => command[id],
      auto(/** @type {string} */ id) {
        const p = b.inputs.find((q) => q.id === id);
        return p ? /** @type {any} */ (INPUTS)[p.role].auto : undefined;
      },
      step,
      read,
      settle,
      /** Expected terminal flow for a blade position at the current static pressure. */
      expectedFlow(/** @type {number} */ index, /** @type {number} */ pct) {
        const x = solve();
        return kDesign[index] * flowCoefficient(pct) * Math.sqrt(x.pressure);
      },
    };
  }

  // ---- functional test: terminal damper stroke ----

  /**
   * Generate the stroke-test plan from the model: one group per terminal that has a damper command and a
   * damper position feedback, each stepped closed, open, then mid. Terminals without both are listed as skipped.
   * @param {any} sim
   * @param {{ targets?: number[], tolerance?: number, timeoutS?: number, captureS?: number, staticLimitPa?: number, minStaticPa?: number }} [opts]
   */
  function strokePlan(sim, opts = {}) {
    const targets = opts.targets || [0, 100, 50];
    const groups = [];
    const skipped = [];
    for (const t of sim.binding.terminals) {
      if (!t.cmd || !t.pos) { skipped.push({ terminal: t.id, label: t.label, reason: !t.cmd ? 'no damper_position_command' : 'no damper_position feedback' }); continue; }
      groups.push({
        terminal: t.id,
        label: t.label,
        steps: targets.map((target, i) => ({ step_id: `${t.id}_${i + 1}`, name: `${t.label} step ${i + 1}`, target })),
      });
    }
    return {
      kind: 'damper_stroke',
      tolerance: opts.tolerance ?? 5,
      flowTolerance: 0.2,
      timeoutS: opts.timeoutS ?? 120,
      captureS: opts.captureS ?? 10,
      staticLimitPa: opts.staticLimitPa ?? 750,
      minStaticPa: opts.minStaticPa ?? 40,
      groups,
      skipped,
    };
  }

  /**
   * Deterministic diagnosis for one step from what the sensors showed.
   * @param {{ target: number, feedback: number, flow: number|null, expectedAtCommand: number|null, expectedAtFeedback: number|null, tolerance: number, flowTolerance: number, reached: boolean, moved: boolean }} s
   */
  function diagnose(s) {
    const near = (/** @type {number|null} */ a, /** @type {number|null} */ b, /** @type {number} */ tol) => a !== undefined && a !== null && b !== undefined && b !== null && Math.abs(a - b) <= Math.max(tol * Math.abs(b), 5);
    const feedbackOk = Math.abs(s.feedback - s.target) <= s.tolerance;
    const flowMatchesCommand = near(s.flow, s.expectedAtCommand, s.flowTolerance);
    const flowMatchesFeedback = near(s.flow, s.expectedAtFeedback, s.flowTolerance);
    if (feedbackOk && ((s.flow === undefined || s.flow === null) || flowMatchesCommand)) return { pass: true, cause: null, explanation: [] };
    if (feedbackOk && !flowMatchesCommand) {
      return {
        pass: false,
        cause: 'linkage',
        explanation: [
          `Feedback reached ${round(s.feedback)}% as commanded, but airflow ${round(s.flow || 0)} L/s does not match the ${round(s.expectedAtCommand || 0)} L/s expected at that position.`,
          'The actuator is turning while the blade is not following: suspect a slipped or loose linkage or shaft coupling.',
        ],
      };
    }
    if (!feedbackOk && flowMatchesCommand) {
      return {
        pass: false,
        cause: 'feedback_scaling',
        explanation: [
          `Airflow ${round(s.flow || 0)} L/s matches the commanded ${s.target}% position, but feedback reads ${round(s.feedback)}%.`,
          'The blade moved; the position signal is wrong: check feedback scaling, span or the analog input range.',
        ],
      };
    }
    if (!feedbackOk && ((s.flow === undefined || s.flow === null) || flowMatchesFeedback)) {
      return {
        pass: false,
        cause: 'actuator_binding',
        explanation: [
          `Commanded ${s.target}%, feedback stalled at ${round(s.feedback)}%${s.flow !== undefined && s.flow !== null ? ` and airflow ${round(s.flow)} L/s agrees with the stalled position` : ''}.`,
          `${s.moved ? 'The actuator moved and then stopped short' : 'The actuator did not move'} before the ${s.reached ? 'capture' : 'timeout'}: suspect actuator binding or a mechanical obstruction of the blade.`,
        ],
      };
    }
    return {
      pass: false,
      cause: 'inconsistent',
      explanation: [`Feedback ${round(s.feedback)}% and airflow ${round(s.flow || 0)} L/s disagree with the command and with each other; inspect on site.`],
    };
  }

  /**
   * Run the stroke test against a sim, recording one frame per second. Every override the test made is
   * released on every way out (pass, fail, interlock, timeout, abort) and the release is verified.
   * @param {any} sim
   * @param {any} plan from strokePlan
   * @param {{ abortAtS?: number, maxRunS?: number }} [opts]
   */
  function runStroke(sim, plan, opts = {}) {
    /** @type {any[]} */
    const frames = [];
    /** @type {Map<string, number>} input id -> value before the test overrode it */
    const overridden = new Map();
    const maxRunS = opts.maxRunS ?? 3600;
    let phase = 'PRECHECK';
    let label = 'PRECHECK';
    /** @type {any} */
    let current = null;
    /** @type {string|null} */
    let stopReason = null;
    const results = [];

    const t0 = sim.read().t;
    const snapshot = () => {
      const r = sim.read();
      frames.push({ t: r.t - t0, phase, label, step: current, overrides: [...overridden.keys()], values: r.values, scene: r.scene });
      return r;
    };
    const tick = () => {
      sim.step(1);
      const r = snapshot();
      if (r.t - t0 >= maxRunS && !stopReason) stopReason = 'run_timeout';
      if (opts.abortAtS !== undefined && opts.abortAtS !== null && r.t - t0 >= opts.abortAtS && !stopReason) stopReason = 'operator_abort';
      if (r.scene.staticPa > plan.staticLimitPa && !stopReason) stopReason = 'interlock_static_pressure';
      return r;
    };
    const override = (/** @type {string} */ id, /** @type {number} */ value) => {
      if (!overridden.has(id)) overridden.set(id, sim.get(id));
      sim.set(id, value);
    };
    const release = (/** @type {string[]} */ ids) => {
      for (const id of ids) {
        if (!overridden.has(id)) continue;
        sim.set(id, /** @type {number} */ (overridden.get(id)));
        overridden.delete(id);
      }
    };

    // Precheck: fan proven and duct pressure present, from whatever the model has.
    let r = snapshot();
    const b = sim.binding;
    const status = b.ahu.supply_fan_operating_status;
    const dsp = b.ahu.discharge_air_static_pressure;
    /** @type {string[]} */
    const precheck = [];
    if (status && r.values[status.id] !== true) precheck.push('supply fan not proven on');
    if (dsp && Number(r.values[dsp.id]) < plan.minStaticPa) precheck.push(`duct static ${r.values[dsp.id]} Pa below ${plan.minStaticPa} Pa`);
    if (!plan.groups.length) precheck.push('no terminal has both a damper command and damper position feedback');
    if (precheck.length) stopReason = `precheck: ${precheck.join('; ')}`;

    for (const group of plan.groups) {
      if (stopReason) break;
      const index = b.terminals.findIndex((/** @type {any} */ t) => t.id === group.terminal);
      const t = b.terminals[index];
      let groupFailed = false;
      for (const s of group.steps) {
        if (stopReason || groupFailed) break;
        current = { terminal: group.terminal, step_id: s.step_id, target: s.target };
        phase = 'OVERRIDE'; label = `OVERRIDE · ${s.name}`;
        override(t.cmd.id, s.target);
        r = tick();
        phase = 'SETTLE'; label = `SETTLE · ${s.name}`;
        let waited = 0;
        let reached = false;
        const startFeedback = Number(r.values[t.pos.id]);
        let lastFeedback = startFeedback;
        let still = 0;
        while (!stopReason && waited < plan.timeoutS) {
          r = tick();
          waited += 1;
          const fb = Number(r.values[t.pos.id]);
          if (Math.abs(fb - s.target) <= plan.tolerance) { reached = true; break; }
          still = Math.abs(fb - lastFeedback) < 0.05 ? still + 1 : 0;
          lastFeedback = fb;
        }
        if (stopReason) break;
        phase = 'CAPTURE'; label = `CAPTURE · ${s.name}`;
        let fbSum = 0; let flowSum = 0; let n = 0;
        for (let i = 0; i < plan.captureS && !stopReason; i += 1) {
          r = tick();
          fbSum += Number(r.values[t.pos.id]);
          if (t.flow) flowSum += Number(r.values[t.flow.id]);
          n += 1;
        }
        if (stopReason) break;
        const fbAvg = fbSum / n;
        const flowAvg = t.flow ? flowSum / n : null;
        const d = diagnose({
          target: s.target,
          feedback: fbAvg,
          flow: flowAvg,
          expectedAtCommand: t.flow ? sim.expectedFlow(index, s.target) : null,
          expectedAtFeedback: t.flow ? sim.expectedFlow(index, fbAvg) : null,
          tolerance: plan.tolerance,
          flowTolerance: plan.flowTolerance,
          reached,
          moved: Math.abs(fbAvg - startFeedback) > 1,
        });
        results.push({
          terminal: group.terminal,
          label: group.label,
          step_id: s.step_id,
          target: s.target,
          feedback: round(fbAvg),
          flow: (flowAvg === undefined || flowAvg === null) ? null : round(flowAvg),
          expected_flow: t.flow ? round(sim.expectedFlow(index, s.target)) : null,
          settled_s: waited,
          timed_out: !reached,
          stalled_s: still,
          pass: d.pass,
          cause: d.cause,
          explanation: d.explanation,
        });
        if (!d.pass) groupFailed = true;
      }
      if (stopReason) break; // the final release below handles it
      // Release this terminal before moving on.
      phase = 'RELEASE'; label = `RELEASE · ${group.label}`;
      release([t.cmd.id]);
      r = tick();
      current = null;
    }

    // Final release, whatever happened above.
    phase = 'RELEASE'; label = 'RELEASE';
    current = null;
    const releasing = [...overridden.keys()];
    release(releasing);
    for (let i = 0; i < 3; i += 1) { sim.step(1); snapshot(); }
    const leftover = sim.inputs.filter((/** @type {any} */ p) => overridden.has(p.id));
    const failed = results.filter((x) => !x.pass);
    const outcome = stopReason ? (stopReason.startsWith('precheck') ? 'aborted' : stopReason === 'operator_abort' ? 'aborted' : 'fail')
      : failed.length ? 'fail' : 'pass';
    phase = 'REPORT'; label = `REPORT · ${outcome.toUpperCase()}`;
    snapshot();
    phase = 'IDLE'; label = 'IDLE';
    snapshot();
    return {
      outcome,
      stop_reason: stopReason,
      precheck,
      results,
      skipped: plan.skipped,
      release: { released_at_end: releasing, remaining: leftover.map((/** @type {any} */ p) => p.id), ok: leftover.length === 0 },
      frames,
      nf_writes: 0,
    };
  }


  // ---- scene layout (pure; the renderer only draws what this returns) ----

  /**
   * Lay out a discovered unit for the 3D view: AHU parts along x in air-path order (lanes on z), the supply
   * trunk continuing on x, one branch per terminal, and the served space past each terminal. Every element
   * keeps its model id, so highlights and labels map back to points.
   * @param {any} unit
   * @param {(unit: any) => any[]} points
   */
  function layout(unit, points, model) {
    const pts = points(unit);
    const STEP = 1.9;
    const onPath = unit.parts.filter((/** @type {any} */ p) => p.layer !== undefined && p.layer !== null);
    const layers = new Map();
    for (const p of onPath) {
      if (!layers.has(p.layer)) layers.set(p.layer, []);
      layers.get(p.layer).push(p);
    }
    const maxLayer = Math.max(0, ...onPath.map((/** @type {any} */ p) => p.layer));
    const maxLanes = Math.max(1, ...[...layers.values()].map((l) => l.length));
    const width = Math.max(1.6, maxLanes * 1.5);
    /** @type {any[]} */
    const elements = [];
    const cmdOf = (/** @type {string} */ part, /** @type {RegExp} */ re) => {
      const p = pts.find((q) => q.part === part && q.actuatable && re.test(q.role || ''));
      return p ? p.id : null;
    };
    for (const [layer, list] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort((/** @type {any} */ a, /** @type {any} */ b) => a.lane - b.lane);
      list.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
        const z = (i - (list.length - 1) / 2) * 1.5;
        elements.push({ id: p.id, kind: p.kind, label: p.label, scope: 'ahu', pos: [layer * STEP, 0, z], size: [0.9, 1.3, list.length > 1 ? 1.3 : width - 0.2], command: cmdOf(p.id, /command$/) });
      });
    }
    const byId = new Map(elements.map((e) => [e.id, e]));
    for (const p of unit.parts.filter((/** @type {any} */ q) => (q.layer === undefined || q.layer === null))) {
      const host = p.links && p.links.length ? byId.get(p.links[0]) : null;
      const pos = host ? [host.pos[0], 1.25, host.pos[2]] : [maxLayer * STEP / 2, 1.25, -width / 2];
      elements.push({ id: p.id, kind: p.kind, label: p.label, scope: 'ahu', pos, size: [0.35, 0.35, 0.35], host: host ? host.id : null, command: cmdOf(p.id, /command$/) });
    }
    // Coils take their valve's command so they can glow with it.
    for (const e of elements) {
      if (!/coil/.test(e.kind)) continue;
      const valve = elements.find((v) => v.host === e.id && v.command);
      if (valve) e.command = valve.command;
    }
    const casing = { id: unit.id, label: unit.label, from: [-STEP / 2, -0.8, -width / 2], to: [maxLayer * STEP + STEP / 2, 0.8, width / 2] };
    const outletX = casing.to[0];
    const nTerm = unit.terminals.length;
    const banks = nTerm > 6 ? 2 : 1;
    const pitch = nTerm <= 1 ? 3.2 : nTerm <= 3 ? 3.6 : nTerm <= 6 ? 2.8 : 2.2;
    const terminals = unit.terminals.map((/** @type {any} */ t, /** @type {number} */ i) => {
      const col = banks === 1 ? i : Math.floor(i / banks);
      const bank = banks === 1 ? 1 : (i % banks === 0 ? 1 : -1);
      const x = outletX + 2.6 + col * pitch;
      const damper = t.parts.find((/** @type {any} */ p) => p.kind === 'damper');
      const reheat = t.parts.find((/** @type {any} */ p) => /coil/.test(p.kind));
      const valve = t.parts.find((/** @type {any} */ p) => p.kind === 'valve');
      const tap = [x, 0, 0];
      const boxZ = bank * (width / 2 + 2.6);
      const box = [x, 0, boxZ];
      const zone = [x, -0.95, boxZ + (bank > 0 ? 2.8 : -2.8)];
      return {
        id: t.id,
        index: i,
        label: t.label,
        zone: t.zone ? { id: t.zone.id, label: t.zone.label } : null,
        damper: damper ? damper.id : null,
        reheat: reheat ? reheat.id : null,
        valve: valve ? valve.id : null,
        valveCommand: valve ? cmdOf(valve.id, /command$/) : null,
        tap,
        box,
        zonePos: zone,
        path: [[outletX, 0, 0], tap, box, [zone[0], 0, zone[2]]],
      };
    });
    const trunkEnd = terminals.length ? terminals[terminals.length - 1].tap[0] : outletX + 1.5;
    const ducts = [{ id: 'trunk', from: [outletX, 0, 0], to: [trunkEnd + 0.4, 0, 0], radius: 0.42 }];
    for (const t of terminals) ducts.push({ id: `branch_${t.id}`, from: t.tap, to: t.box, radius: 0.26, terminal: t.index });
    for (const t of terminals) ducts.push({ id: `drop_${t.id}`, from: t.box, to: [t.zonePos[0], 0, t.zonePos[2] - 0.8], radius: 0.2, terminal: t.index });
    // Intake paths into each first-layer part (outdoor or return air).
    const intakes = (layers.get(0) || []).map((/** @type {any} */ p) => {
      const e = byId.get(p.id);
      return { part: p.id, path: [[e.pos[0] - 2.2, 0, e.pos[2]], e.pos, [outletX, 0, 0]] };
    });
    /** point id -> element id it belongs to (for amber and red outlines) */
    const pointPart = {};
    for (const p of pts) /** @type {any} */ (pointPart)[p.id] = p.part;
    let center = [(casing.from[0] + trunkEnd) / 2 + 1.5, 0, width / 2 + 2.4];
    /** @type {{ min: number[], max: number[], size: number[], center: number[] } | null} */
    let bounds = null;

    // Hydronic plants and unknown equipment from the rest of the discovered model (optional third argument).
    /** @type {any[]} */
    const pipes = [];
    /** @type {any[]} */
    const plants = [];
    if (model) {
      const plantList = model.plants || [];
      const hw = plantList.filter((/** @type {any} */ p) => p.kind === 'boiler' || (p.kind === 'pump' && /hot|heat|boiler/i.test(p.label)));
      const chw = plantList.filter((/** @type {any} */ p) => p.kind === 'chiller' || (p.kind === 'pump' && /chill|cool/i.test(p.label)));
      const used = new Set();
      const placePlant = (/** @type {any[]} */ group, /** @type {number} */ zSide, /** @type {string} */ medium) => {
        group.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
          if (used.has(p.id)) return;
          used.add(p.id);
          const pos = [casing.from[0] + i * 2.2, 0, zSide * (width / 2 + 6.2)];
          const el = { id: p.id, kind: p.kind || 'equipment', label: p.label, scope: 'plant', pos, size: p.kind === 'pump' ? [0.8, 0.8, 0.8] : [1.4, 1.3, 1.1], command: cmdOf(p.id, /command$|status$/) };
          elements.push(el);
          plants.push(el);
          // Pipes from the plant to every heating/cooling coil in this unit (and terminal reheat).
          const coils = elements.filter((e) => (medium === 'hot_water' ? /heating_coil/.test(e.kind) : /cooling_coil/.test(e.kind)));
          const reheats = medium === 'hot_water' ? terminals.filter((t) => t.reheat) : [];
          for (const c of coils) {
            pipes.push({ id: `pipe_${p.id}_${c.id}_sup`, medium, from: pos, to: c.pos, path: [pos, [pos[0], 0, c.pos[2]], c.pos] });
          }
          for (const t of reheats) {
            pipes.push({ id: `pipe_${p.id}_${t.id}_sup`, medium, from: pos, to: t.box, path: [pos, [t.box[0], 0, pos[2]], t.box] });
          }
        });
      };
      placePlant(hw, -1, 'hot_water');
      placePlant(chw, 1, 'chilled_water');
      for (const p of plantList) {
        if (used.has(p.id)) continue;
        used.add(p.id);
        const pos = [casing.from[0] - 2.5, 0, width / 2 + 6.2];
        const el = { id: p.id, kind: p.kind || 'equipment', label: p.label, scope: 'plant', pos, size: [1.2, 1.1, 1.1] };
        elements.push(el);
        plants.push(el);
      }
      for (const o of model.other || []) {
        const pos = [casing.to[0] + 1.5, 0, -(width / 2 + 5)];
        elements.push({ id: o.id, kind: o.kind || 'equipment', label: o.label, scope: 'other', pos, size: [1.1, 1.1, 1.1] });
      }
      const xs = elements.map((e) => e.pos[0]).concat(terminals.map((t) => t.box[0]));
      const zs = elements.map((e) => e.pos[2]).concat(terminals.map((t) => t.box[2]));
      if (xs.length && zs.length) center = [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2];
    }

    const xs = [casing.from[0], casing.to[0]];
    const ys = [casing.from[1], casing.to[1]];
    const zs = [casing.from[2], casing.to[2]];
    const add = (/** @type {any} */ p) => {
      if (!p || p.length < 3) return;
      const x = Number(p[0]); const y = Number(p[1]); const z = Number(p[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      xs.push(x); ys.push(y); zs.push(z);
    };
    for (const t of terminals) { add(t.box); add(t.zonePos); add(t.tap); }
    for (const e of elements) add(e.pos);
    for (const d of ducts) { add(d.from); add(d.to); }
    for (const pipe of pipes) {
      add(pipe.from); add(pipe.to);
      for (const pt of pipe.path || []) add(pt);
    }
    for (const inn of intakes) {
      for (const pt of inn.path || []) add(pt);
    }
    const pad = 1.8;
    const min = [Math.min(...xs) - pad, Math.min(...ys) - 0.6, Math.min(...zs) - pad];
    const max = [Math.max(...xs) + pad, Math.max(...ys) + 1.2, Math.max(...zs) + pad];
    bounds = { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
    center = bounds.center;
    return { casing, elements, terminals, ducts, intakes, pipes, plants, pointPart: /** @type {Record<string, string>} */ (pointPart), center, bounds };
  }

  /**
   * A latest value without its wrappers: the page's { value, ts } entry, and NF's own { ts, double | float | integer | boolean }.
   * @param {any} v
   */
  function unwrap(v) {
    for (let i = 0; i < 3 && v && typeof v === 'object' && !Array.isArray(v); i += 1) {
      const k = ['value', 'double', 'float', 'integer', 'int', 'uint', 'boolean', 'bool'].find((key) => key in v);
      v = k ? v[k] : null;
    }
    return v;
  }

  /**
   * Build a scene frame from live (or demo) point values. Missing readings stay null and flow animation stops.
   * @param {any} unit
   * @param {(unit: any) => any[]} pointsFn
   * @param {Record<string, any>} values map of point id -> number | { value, ts }
   */
  function liveFrame(unit, pointsFn, values) {
    const num = (/** @type {any} */ v) => {
      v = unwrap(v);
      if (v === true || v === 'true') return 1;
      if (v === false || v === 'false') return 0;
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const pts = pointsFn(unit);
    const find = (/** @type {string} */ equipment, /** @type {string} */ role) => pts.find((p) => p.equipment === equipment && p.role === role) || null;
    const read = (/** @type {any} */ point) => (point ? num(values[point.id]) : null);
    const first = (/** @type {string} */ equipment, /** @type {string[]} */ roles) => {
      for (const r of roles) {
        const p = find(equipment, r);
        const v = read(p);
        if ((v !== undefined && v !== null)) return v;
      }
      return null;
    };
    const fanSpeed = first(unit.id, ['supply_fan_speed_command', 'supply_fan_speed']);
    const fanOnRaw = first(unit.id, ['supply_fan_operating_status', 'supply_fan_command']);
    const fanOn = (fanOnRaw === undefined || fanOnRaw === null) ? ((fanSpeed !== undefined && fanSpeed !== null) && fanSpeed > 0) : fanOnRaw >= 0.5;
    const terminals = (unit.terminals || []).map((/** @type {any} */ t) => {
      const cmd = read(find(t.id, 'damper_position_command'));
      const fb = read(find(t.id, 'damper_position'));
      const flow = first(t.id, ['discharge_air_volume_flow_rate']);
      const maxP = find(t.id, 'discharge_air_volume_flow_rate_maximum');
      const maxLps = read(maxP) || num(maxP && maxP.value) || 300;
      return {
        id: t.id,
        blade: (fb !== undefined && fb !== null) ? fb : ((cmd !== undefined && cmd !== null) ? cmd : 0),
        feedback: fb,
        command: cmd,
        flowLps: (flow !== undefined && flow !== null) ? flow : 0,
        flowKnown: (flow !== undefined && flow !== null),
        maxLps,
        reheat: first(t.id, ['terminal_unit_heating_valve_position_command', 'heating_valve_position']) || 0,
        dat: first(t.id, ['terminal_unit_discharge_air_temperature', 'discharge_air_temperature']),
        zoneTemp: first(t.id, ['zone_air_temperature']),
      };
    });
    const totalLps = terminals.reduce((a, t) => a + (t.flowKnown ? t.flowLps : 0), 0);
    const oa = first(unit.id, ['outdoor_air_intake_damper_position', 'outdoor_air_intake_damper_position_command']);
    const ra = first(unit.id, ['return_damper_position', 'return_damper_position_command']);
    const valueMap = {};
    for (const p of pts) {
      const v = num(values[p.id]);
      if ((v !== undefined && v !== null)) valueMap[p.id] = v;
    }
    return {
      t: 0,
      values: valueMap,
      scene: {
        fanOn,
        fanSpeed: (fanSpeed !== undefined && fanSpeed !== null) ? fanSpeed : (fanOn ? 70 : 0),
        staticPa: first(unit.id, ['discharge_air_static_pressure']) || 0,
        staticKnown: first(unit.id, ['discharge_air_static_pressure']) !== undefined && first(unit.id, ['discharge_air_static_pressure']) !== null,
        totalLps,
        oaFraction: (oa !== undefined && oa !== null) && (ra !== undefined && ra !== null) && (oa + ra) > 0 ? oa / (oa + ra) : ((oa !== undefined && oa !== null) ? oa / 100 : 0),
        sat: first(unit.id, ['discharge_air_temperature', 'air_handling_unit_discharge_air_temperature']),
        mat: first(unit.id, ['mixed_air_temperature']),
        cooling: first(unit.id, ['cooling_valve_position', 'cooling_valve_position_command']) || 0,
        heating: first(unit.id, ['heating_valve_position', 'heating_valve_position_command']) || 0,
        outdoorDamper: oa || 0,
        returnDamper: ra || 0,
        terminals,
      },
    };
  }

  /** Static pressure colour ramp (fraction of the limit): low teal, design green, high amber, over limit red. */
  function pressureColor(/** @type {number} */ pa, /** @type {number} */ limit) {
    const f = clamp(pa / (limit || 1), 0, 1.2);
    const stops = [[0, [0.18, 0.55, 0.62]], [0.4, [0.24, 0.78, 0.45]], [0.8, [0.95, 0.72, 0.2]], [1, [0.93, 0.3, 0.27]], [1.2, [0.93, 0.3, 0.27]]];
    for (let i = 1; i < stops.length; i += 1) {
      const [f1, c1] = /** @type {[number, number[]]} */ (stops[i]);
      const [f0, c0] = /** @type {[number, number[]]} */ (stops[i - 1]);
      if (f <= f1) {
        const u = (f - f0) / (f1 - f0 || 1);
        return c0.map((c, k) => round(c + (c1[k] - c) * u, 3));
      }
    }
    return [0.93, 0.3, 0.27];
  }

  return { INPUTS, FEEDBACK, ENV, createSim, strokePlan, runStroke, diagnose, parseFault, flowCoefficient, bind, layout, liveFrame, unwrap, pressureColor };
});
