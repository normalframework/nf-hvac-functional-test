// Demo mode: the whole page on fixture data (demo-data.js) with no station. Nothing is sent anywhere.
// A simulated run loops on an accelerated clock so the state machine, countdowns and commands move.
// Browser global NfftDemo.
(function (root) {
  'use strict';

  const SCALE = 60;
  const IDLE_MS = 8000;
  const PRECHECK_MS = 3000;
  const WRITE_MS = 1500;
  const RELEASE_MS = 3000;
  const REPORT_MS = 8000;

  function create() {
    const data = /** @type {any} */ (root).NfftDemoData;
    const Trigger = /** @type {any} */ (root).NfftTrigger;
    const Rrule = /** @type {any} */ (root).NfftRrule;
    const preview = data.preview;
    const steps = preview.steps;
    const work = steps.filter((/** @type {any} */ s) => s.step_id !== 'recovery');
    const recovery = steps.find((/** @type {any} */ s) => s.step_id === 'recovery');
    let doc = Trigger.normalize(data.trigger);
    let t0 = Date.now();
    /** @type {null | { at: number, from: string }} */
    let aborted = null;
    let attention = false;
    let runSeq = 1;

    const simNow = () => t0 + (Date.now() - t0) * SCALE;
    const runId = () => `demo-run-${String(runSeq).padStart(3, '0')}`;

    /** Timeline in real ms from t0. */
    function timeline() {
      /** @type {{ phase: string, start: number, end: number, index: number, written: number }[]} */
      const parts = [];
      let t = IDLE_MS;
      parts.push({ phase: 'IDLE', start: 0, end: t, index: -1, written: 0 });
      parts.push({ phase: 'PRECHECK', start: t, end: t + PRECHECK_MS, index: -1, written: 0 });
      t += PRECHECK_MS;
      work.forEach((/** @type {any} */ step, /** @type {number} */ i) => {
        const len = step.hold_ms / SCALE;
        const phase = step.step_id === 'ahu.baseline' ? 'BASELINE' : 'STEP';
        const writes = (step.writes || []).length;
        parts.push({ phase, start: t, end: t + len, index: steps.indexOf(step) >= 0 ? steps.indexOf(step) : i, written: writes ? t + WRITE_MS : t });
        t += len;
      });
      parts.push({ phase: 'RELEASING', start: t, end: t + RELEASE_MS, index: steps.length - 2, written: 0 });
      t += RELEASE_MS;
      if (recovery) {
        const len = recovery.hold_ms / SCALE;
        parts.push({ phase: 'RECOVERY', start: t, end: t + len, index: steps.indexOf(recovery), written: 0 });
        t += len;
      }
      parts.push({ phase: 'COMPLETE', start: t, end: t + REPORT_MS, index: steps.length - 1, written: 0 });
      return { parts, total: t + REPORT_MS };
    }
    const plan = timeline();

    function current() {
      let elapsed = Date.now() - t0;
      if (aborted) {
        const since = Date.now() - aborted.at;
        if (since > RELEASE_MS + REPORT_MS) {
          aborted = null;
          runSeq += 1;
          t0 = Date.now();
          elapsed = 0;
        } else {
          return { phase: since < RELEASE_MS ? 'RELEASING' : 'ABORTED', start: aborted.at - t0, index: -1, written: 0, reason: 'abort' };
        }
      }
      if (elapsed >= plan.total) {
        runSeq += 1;
        t0 = Date.now();
        elapsed = 0;
      }
      const part = plan.parts.find((p) => elapsed >= p.start && elapsed < p.end) || plan.parts[0];
      return { ...part, reason: part.phase === 'COMPLETE' ? 'complete' : '' };
    }

    function status() {
      const part = current();
      const sim = (/** @type {number} */ realOffset) => t0 + realOffset * SCALE;
      const active = !['IDLE', 'COMPLETE', 'ABORTED'].includes(part.phase);
      const elapsedReal = Date.now() - t0;
      return {
        ok: true,
        state: attention ? 'NEEDS_ATTENTION' : part.phase,
        step_index: part.index,
        run_id: part.phase === 'IDLE' ? '' : runId(),
        overrides: active ? 4 : 0,
        needs_attention: attention,
        dry_run: true,
        capability: [],
        reason: part.reason || '',
        run_started_at: sim(IDLE_MS),
        step_started_at: sim(part.start),
        step_written: part.written === 0 || elapsedReal >= part.written,
        max_total_ms: 150 * 60000,
        pending_start: false,
        steps: steps.map((/** @type {any} */ s) => ({ step_id: s.step_id, hold_ms: s.hold_ms, settle_ms: s.settle_ms, writes: (s.writes || []).length })),
      };
    }

    function commands() {
      const s = status();
      if (!['BASELINE', 'STEP'].includes(s.state) || !s.step_written) return [];
      const step = steps[s.step_index];
      const byEquip = new Map();
      for (const w of step.writes || []) byEquip.set(w.equipment_id, (byEquip.get(w.equipment_id) || 0) + 1);
      const now = simNow();
      const lease = preview.lease_s * 1000;
      const renewed = now - ((now - s.step_started_at) % 60000);
      return [...byEquip.entries()].map(([equip, count], i) => ({
        id: 100 + i,
        name: `ftest-${s.run_id}-${equip}`,
        writes: count,
        expires_at: new Date(renewed + lease).toISOString(),
        lease_ms: lease,
      }));
    }

    function view(note) {
      const now = Date.now();
      return {
        ok: true,
        note: note || null,
        trigger: { ...doc, history: doc.history.slice(-20) },
        describe: Rrule.describe(doc.rule),
        rrule: Rrule.toRrule(doc.rule),
        next_runs: Trigger.preview(doc, now, undefined, 6),
        arm_phrase: Trigger.ARM_PHRASE,
        writes: 0,
      };
    }

    const later = (/** @type {any} */ value) => new Promise((ok) => setTimeout(() => ok(value), 120));
    /** @type {Promise<any>|null} */
    let records = null;
    // Demo NF records (static/demo-nf-records.json): the graphic derives its model from these tags as it would on a live NF.
    const demoRecords = () => {
      if (!records) records = fetch('demo-nf-records.json', { credentials: 'same-origin' }).then((r) => r.json());
      return records;
    };

    const MIXED_VENDOR_CONFIG = {
      version: 1,
      dry_run: true,
      equipment: [
        { id: 'vav-01', type: 'vav', vav_override: { strategy: 'write_airflow_setpoint' } },
        { id: 'vav-02', type: 'vav', vav_override: { strategy: 'toggle_boolean', role: 'purge_operating_mode_command', on: 1, off: 0 } },
        { id: 'vav-03', type: 'vav', vav_override: { strategy: 'set_multistate', role: 'maximum_cooling_operating_mode_command', value: 1, release: 0 } },
      ],
    };
    return {
      kind: 'demo',
      siteConfig: MIXED_VENDOR_CONFIG,
      scale: SCALE,
      now: simNow,
      status: () => later(status()),
      async trigger(/** @type {string} */ op, /** @type {any} */ payload) {
        if (op === 'get') return later(view(null));
        const result = Trigger.apply(doc, { ...(payload || {}), op, now: Date.now() });
        if (!result.ok) return later({ ...result, writes: 0 });
        doc = result.doc;
        return later(view(result.note));
      },
      planPreview: () => later(preview),
      start(/** @type {any} */ _payload) {
        return later({ ok: true, demo: true, state: 'IDLE', pending: false, writes: 0 });
      },
      abort(/** @type {any} */ _payload) {
        if (!aborted) aborted = { at: Date.now(), from: current().phase };
        return later(status());
      },
      retryRelease() {
        attention = false;
        return later(status());
      },
      acknowledge() {
        attention = false;
        return later(status());
      },
      commands: () => later(commands()),
      openFddHook: null,
      demoRecords,
      async queryAll(/** @type {any} */ body) {
        const r = await demoRecords();
        const list = body.layer === 'model' ? r.model : r.points;
        const f = body.structuredQuery && body.structuredQuery.field;
        return f ? list.filter((/** @type {any} */ x) => (x.attrs || {})[f.property] === f.text) : list;
      },
      schedules: () => later([{ uuid: data.schedule.schedule.uuid, name: data.schedule.schedule.name }]),
      schedule: () => later(data.schedule),
      hookRuns(/** @type {string} */ hook) {
        const now = Date.now();
        const every = hook === 'tick' ? 10000 : 60000;
        return later(Array.from({ length: 8 }, (_, i) => ({
          pid: 4000 + i,
          state: 'STATE_SUCCESS',
          start_time: new Date(Math.floor(now / every) * every - i * every).toISOString(),
          duration_ms: hook === 'tick' ? 180 : 35,
        })));
      },
      history: () => data.history,
      site: data.site,
    };
  }

  root.NfftDemo = { create };
})(globalThis);
