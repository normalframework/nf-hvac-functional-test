'use strict';

const { createState, next } = require('./machine');
const { evaluateInterlocks } = require('./interlocks');
const { convertToSi, deviceNumber, siUnitFor } = require('./units');
const { getRole } = require('./roles');
const { assessPriority, economizerEligible } = require('./capability');
const { Sampler } = require('./sampler');
const { createManifest, openStep, finishManifest, writeManifest } = require('./manifest');
const { allocateRunSeq } = require('./run_seq');
const { releaseEntries, recover } = require('./writers/release');
const { parsePriorityArray, slotMatches } = require('./writers/verify');
const { guardWrite } = require('./writers/guard');
const { createWriter, createReleaseWriters } = require('./writers');
const { executeVav, orderRelease } = require('./vav/execute');

class Runner {
  /**
   * @param {any} options
   */
  constructor(options) {
    this.client = options.client;
    this.ledger = options.ledger;
    this.config = options.config;
    this.plan = options.plan;
    this.model = options.model;
    this.clock = options.clock;
    this.sleep = options.sleep || (async () => {});
    this.fanOnMs = options.fanOnMs === undefined ? 5 * 60 * 1000 : options.fanOnMs;
    this.sampleAgeS = options.sampleAgeS || 0;
    this.manifestDir = options.manifestDir || '';
    this.seqDir = options.seqDir || '';
    this.points = indexPoints(options.model);
    this.writer = options.writer || createWriter({
      config: writerConfig(options.config),
      confirmLive: options.confirmLive === true,
      client: options.client,
      ledger: options.ledger,
    });
    this.state = createState({
      maxCommFailures: options.config.limits.max_comm_failures,
      maxTotalMs: options.config.limits.max_total_minutes * 60 * 1000,
      maxTickGapMs: options.config.limits.max_tick_gap_s * 1000,
    });
    this.effects = [];
    /** @type {{ outOfBandSince: number | null, staleStrikes: number }} */
    this.memory = { outOfBandSince: null, staleStrikes: 0 };
    this.fanOnSince = null;
    this.attention = 0;
    this.manifest = createManifest('');
    this.sampler = new Sampler({ client: options.client });
    this.runSeq = options.runSeq || 1;
    /** @type {any[]} */
    this.vavReport = [];
    this.draining = false;
    /** @type {number | null} */
    this.lastExtendAt = null;
    this.paced = false;
    this.vavIndex = 0;
    /** @type {number} */
    this.nextRetryAt = 0;
  }

  /**
   * @param {any} result
   */
  apply(result) {
    this.state = result.state;
    this.effects.push(...result.effects);
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      let steps = 0;
      while (this.effects.length && steps < 40) {
        steps += 1;
        const effect = this.effects.shift();
        /** @type {any} */
        let follow = null;
        try {
          follow = await this.exec(effect);
        } catch {
          this.effects = [];
          this.apply(next(this.state, { type: 'EXCEPTION', reason: 'exception' }));
          continue;
        }
        if (follow) this.apply(next(this.state, follow));
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * @param {string} runId
   */
  async start(runId) {
    if (this.ledger.openOverrides().length || this.ledger.openPeriods().length) {
      await this.recover();
      if (this.state.needsAttention) return this.state;
    }
    const steps = runnableSteps(this.plan, this.config);
    const mismatch = await this.commandPriorityFault();
    if (mismatch) {
      this.state = { ...this.state, phase: 'FAILED', reason: mismatch, runId };
      return this.state;
    }
    if (this.seqDir) this.runSeq = allocateRunSeq(this.seqDir);
    this.manifest = createManifest(runId, { run_seq: this.runSeq });
    this.manifest.dry_run = this.config.dry_run !== false;
    this.manifest.started_at = new Date(this.clock.now()).toISOString();
    writeManifest(this.manifest, this.manifestDir);
    this.apply(next(this.state, { type: 'START', now: this.clock.now(), runId, steps }));
    await this.drain();
    return this.state;
  }

  async tick() {
    if (this.state.phase === 'PRECHECK' || this.state.phase === 'BASELINE' || this.state.phase === 'STEP' || this.state.phase === 'RECOVERY') {
      const lease = await this.maybeKeepalive();
      if (lease) {
        this.apply(next(this.state, lease));
        await this.drain();
        return this.state;
      }
      const trip = await this.look();
      if (trip) {
        this.apply(next(this.state, trip));
        await this.drain();
        return this.state;
      }
    }
    this.apply(next(this.state, { type: 'TICK', now: this.clock.now() }));
    await this.drain();
    return this.state;
  }

  async abort() {
    this.effects = [];
    this.apply(next(this.state, { type: 'ABORT', now: this.clock.now(), reason: 'abort' }));
    await this.drain();
    return this.state;
  }

  async retryRelease() {
    this.apply(next(this.state, { type: 'RETRY_RELEASE' }));
    await this.drain();
    return this.state;
  }

  async acknowledge() {
    this.attention = 0;
    this.apply(next(this.state, { type: 'ACKNOWLEDGE' }));
    await this.drain();
    return this.state;
  }

  releaseWriters() {
    const writers = createReleaseWriters({
      config: writerConfig(this.config),
      client: this.client,
      ledger: this.ledger,
    });
    if (this.writer && this.writer.backend && this.writer.backend !== 'dry_run') {
      writers[this.writer.backend] = this.writer;
    }
    return writers;
  }

  /**
   * @param {string} keepRunId
   */
  async recoverForeign(keepRunId) {
    return this.recover(keepRunId);
  }

  /**
   * @param {string} [keepRunId]
   */
  async recover(keepRunId) {
    const result = await recover({
      keepRunId,
      ledger: this.ledger,
      writers: this.releaseWriters(),
      client: this.client,
      retries: this.config.write.release_retries,
      backoff_s: this.config.write.release_backoff_s,
      sleep: this.sleep,
    });
    if (result.needsAttention) {
      this.attention = 1;
      this.state = { ...this.state, phase: 'NEEDS_ATTENTION', needsAttention: true, reason: 'recovery' };
    }
    return result;
  }

  async maybeKeepalive() {
    if (typeof this.writer.keepalive !== 'function') return null;
    const intervalMs = this.config.write.keepalive_s * 1000;
    if (this.lastExtendAt !== null && this.clock.now() - this.lastExtendAt < intervalMs) return null;
    const expires = new Date(this.clock.now() + this.config.write.command_lease_s * 1000).toISOString();
    try {
      const result = await this.writer.keepalive(expires);
      if (result.extended > 0) this.lastExtendAt = this.clock.now();
    } catch {
      return { type: 'COMM_FAILURE' };
    }
    return null;
  }

  async look() {
    const readings = await this.readReadings();
    if (!readings) return { type: 'COMM_FAILURE' };
    if (this.unitFault) return { type: 'INTERLOCK', reason: `interlock:unknown_unit:${this.unitFault}` };
    const judged = evaluateInterlocks(this.interlockConfig(), readings, this.memory, this.clock.now());
    this.memory = judged.memory;
    if (judged.trip) return { type: 'INTERLOCK', reason: `interlock:${judged.trip}` };
    const conflict = await this.overrideConflict();
    if (conflict === 'unreadable') return { type: 'COMM_FAILURE' };
    if (conflict === 'conflict') return { type: 'INTERLOCK', reason: 'interlock:override_conflict' };
    return null;
  }

  /**
   * @param {any} effect
   */
  async exec(effect) {
    if (effect.type === 'precheck') {
      const result = await this.precheck();
      if (result && result.type === 'PRECHECK_OK' && this.config.dry_run === false) await this.maybeBoost();
      return result;
    }
    if (effect.type === 'write') {
      if (effect.step.step_id === 'vav.max_cool') return this.writeVav(effect.step);
      return this.writeStep(effect.step);
    }
    if (effect.type === 'sample') return this.sample();
    if (effect.type === 'release') return this.release();
    if (effect.type === 'econ_check') return this.econCheck();
    if (effect.type === 'enter_step') {
      openStep(this.manifest, {
        step_id: effect.step.step_id,
        index: effect.index,
        started_at: new Date(this.clock.now()).toISOString(),
      });
      return null;
    }
    if (effect.type === 'finish') {
      this.manifest.reason = this.state.reason;
      finishManifest(this.manifest, new Date(this.clock.now()).toISOString(), this.manifestDir);
      return null;
    }
    if (effect.type === 'attention') {
      this.attention = effect.value;
      return null;
    }
    return null;
  }

  async precheck() {
    if (!this.plan.ready) return { type: 'PRECHECK_FAILED', reason: this.plan.reason || 'not_ready', now: this.clock.now() };
    const readings = await this.readReadings();
    if (!readings) return { type: 'COMM_FAILURE' };
    const fan = readings.supply_fan_operating_status;
    if (fan && fan.value !== true) return { type: 'PRECHECK_FAILED', reason: 'fan_off', now: this.clock.now() };
    if (fan && fan.value === true) {
      if (this.fanOnSince === null) this.fanOnSince = this.clock.now();
      if (this.clock.now() - this.fanOnSince < this.fanOnMs) {
        return { type: 'PRECHECK_FAILED', reason: 'fan_not_stable', now: this.clock.now() };
      }
    }
    for (const step of this.state.steps) {
      for (const write of step.writes || []) {
        const point = this.points.get(`${write.equipment_id}|${write.role}`);
        if (!point) return { type: 'PRECHECK_FAILED', reason: `role_unbound:${write.role}`, now: this.clock.now() };
        const slots = await this.readSlots(point.uuid);
        if (slots === 'unreadable') return { type: 'COMM_FAILURE' };
        const assessed = assessPriority(slots, this.config.write.bacnet_priority);
        if (!assessed.ok) return { type: 'PRECHECK_FAILED', reason: assessed.reason, now: this.clock.now() };
      }
    }
    if (this.unitFault) {
      return { type: 'PRECHECK_FAILED', reason: `interlock:unknown_unit:${this.unitFault}`, now: this.clock.now() };
    }
    const judged = evaluateInterlocks(this.interlockConfig(), readings, this.memory, this.clock.now());
    this.memory = judged.memory;
    if (judged.trip) return { type: 'PRECHECK_FAILED', reason: `interlock:${judged.trip}`, now: this.clock.now() };
    return { type: 'PRECHECK_OK', now: this.clock.now() };
  }

  /**
   * @param {any} step
   */
  async writeStep(step) {
    for (const write of step.writes || []) {
      const point = this.points.get(`${write.equipment_id}|${write.role}`);
      if (!point) return { type: 'WRITE_FAILED', reason: 'write_failed' };
      const slots = await this.readSlots(point.uuid);
      const guarded = guardWrite(point, write.value, { priority_array: Array.isArray(slots) });
      if (!guarded.ok) return { type: 'WRITE_FAILED', reason: 'write_failed' };
      const native = deviceNumber(point, write.value);
      if (!native.ok) return { type: 'WRITE_FAILED', reason: 'write_failed' };
      const result = await this.writer.write({
        run_id: this.state.runId,
        equipment_id: write.equipment_id,
        uuid: point.uuid,
        layer: point.layer,
        value: native.value,
      });
      if (!result.ok) return { type: 'WRITE_FAILED', reason: 'write_failed' };
      this.manifest.overrides.push({
        point: point.uuid,
        value: write.value,
        priority: this.config.write.bacnet_priority,
        dry_run: result.dry_run === true,
      });
    }
    return { type: 'STEP_WRITTEN' };
  }

  /**
   * @param {any} step
   */
  async writeVav(step) {
    if (this.paced && this.nextRetryAt && this.clock.now() < this.nextRetryAt) return null;
    const priority = this.config.write.bacnet_priority;
    const result = await executeVav({
      step,
      config: this.config,
      writer: this.writer,
      runId: this.state.runId,
      ahuId: this.plan.equipment_id,
      sleep: this.sleep,
      pace: this.paced === true,
      startIndex: this.vavIndex || 0,
      pointFor: (equipmentId, role) => this.points.get(`${equipmentId}|${role}`) || null,
      readSlot: async (uuid) => {
        const slots = await this.readSlots(uuid);
        if (slots === 'unreadable') return null;
        return slots[priority - 1];
      },
      readNumber: async (equipmentId, role) => {
        const point = this.points.get(`${equipmentId}|${role}`);
        if (!point) return null;
        try {
          const reply = await this.client.readPoints([{ uuid: point.uuid, layer: point.layer }]);
          const row = (reply.results || [])[0];
          if (!row) return null;
          const value = Number(row.scalar);
          return Number.isFinite(value) ? value : null;
        } catch {
          return null;
        }
      },
    });
    this.vavReport = result.report || [];
    if (result.incomplete) {
      this.vavIndex = result.nextIndex;
      this.nextRetryAt = this.clock.now() + (this.config.vav_test.batch_delay_s * 1000);
      return null;
    }
    this.vavIndex = 0;
    for (const row of result.report) {
      if (!row.reason) {
        const point = this.points.get(`${row.equipment_id}|${row.strategy === 'flush_point' ? 'purge_operating_mode_command' : row.strategy === 'bas_toggle' ? 'maximum_cooling_operating_mode_command' : 'discharge_air_volume_flow_rate_setpoint'}`);
        if (point) {
          this.manifest.overrides.push({
            point: point.uuid,
            value: null,
            priority,
            dry_run: this.config.dry_run === true,
          });
        }
      }
    }
    const fatal = result.report.some((row) => row.reason && row.reason !== 'no_effect' && row.reason !== 'write_not_effective');
    if (fatal) return { type: 'WRITE_FAILED', reason: 'write_failed' };
    return { type: 'STEP_WRITTEN' };
  }

  async sample() {
    const readings = await this.readReadings();
    if (!readings) return { type: 'COMM_FAILURE' };
    const step = this.state.steps[this.state.stepIndex];
    const sample = {
      ts: this.clock.now(),
      step_index: this.state.stepIndex,
      step_id: step ? step.step_id : '',
      run_seq: this.runSeq,
      values: Object.fromEntries(Object.entries(readings).map(([role, row]) => [role, row.value])),
    };
    this.manifest.samples.push({ ts: sample.ts, step_index: sample.step_index, step_id: sample.step_id });
    await this.sampler.record(sample);
    return null;
  }

  async econCheck() {
    const readings = await this.readReadings();
    if (!readings) return { type: 'COMM_FAILURE' };
    const oat = readings.outdoor_air_intake_temperature;
    const rat = readings.return_air_temperature;
    const rh = readings.outdoor_air_intake_relative_humidity;
    const ok = economizerEligible({
      oat: oat ? Number(oat.value) : null,
      rat: rat ? Number(rat.value) : null,
      rh: rh ? Number(rh.value) : null,
    }, this.config.plan.econ_window);
    if (ok) return { type: 'ECON_OK', now: this.clock.now() };
    const step = this.state.steps[this.state.stepIndex];
    this.manifest.steps.push({
      step_id: step.step_id,
      index: this.state.stepIndex,
      started_at: new Date(this.clock.now()).toISOString(),
      ended_at: new Date(this.clock.now()).toISOString(),
      skipped: true,
    });
    return { type: 'ECON_SKIP', now: this.clock.now() };
  }

  /**
   * Live nf_command writes use config.write.bacnet_priority.
   * When the platform reports a different BACNET_PRIORITY, refuse before any command starts.
   * @returns {Promise<string | null>}
   */
  async commandPriorityFault() {
    if (this.config.dry_run !== false) return null;
    if (!this.config.write || this.config.write.backend !== 'nf_command') return null;
    if (!this.client || typeof this.client.readCommandPriority !== 'function') return null;
    const service = await this.client.readCommandPriority();
    if (service === null) return null;
    if (service === this.config.write.bacnet_priority) return null;
    return `priority_mismatch:${service}`;
  }

  ownOverrides() {
    const runId = this.state.runId;
    return this.ledger.openOverrides().filter((entry) => !runId || entry.run_id === runId);
  }

  async release() {
    if (this.paced && this.nextRetryAt && this.clock.now() < this.nextRetryAt) return null;
    const ordered = orderRelease(this.ownOverrides(), this.plan.equipment_id);
    const writers = this.releaseWriters();
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const entry of ordered) {
      const backend = entry.backend || 'nf_command';
      const group = groups.get(backend) || [];
      group.push(entry);
      groups.set(backend, group);
    }
    const batchSize = Math.max(1, this.config.vav_test.batch_size);
    let attempts = 0;
    let ok = true;
    if (groups.size === 0) {
      const result = await releaseEntries({
        ledger: this.ledger,
        writer: this.writer,
        entries: [],
        retries: this.config.write.release_retries,
        backoff_s: this.config.write.release_backoff_s,
        sleep: this.sleep,
      });
      attempts += result.attempts;
      ok = result.ok;
    }
    for (const [backend, entries] of groups) {
      const writer = writers[backend];
      if (!writer) {
        ok = false;
        break;
      }
      for (let index = 0; index < entries.length; index += batchSize) {
        const batch = entries.slice(index, index + batchSize);
        const result = await releaseEntries({
          ledger: this.ledger,
          writer,
          entries: batch,
          retries: this.config.write.release_retries,
          backoff_s: this.config.write.release_backoff_s,
          sleep: this.sleep,
          once: this.paced === true,
        });
        attempts += result.attempts;
        if (result.deferred) {
          this.nextRetryAt = this.clock.now() + result.wait_ms;
          return null;
        }
        if (!result.ok) {
          ok = false;
          break;
        }
        if (index + batchSize < entries.length) {
          if (this.paced) {
            this.nextRetryAt = this.clock.now() + (this.config.vav_test.batch_delay_s * 1000);
            return null;
          }
          await this.sleep(this.config.vav_test.batch_delay_s * 1000);
        }
      }
      if (!ok) break;
    }
    const result = { ok, attempts };
    this.manifest.release = { all_verified: result.ok, retries: result.attempts };
    if (!result.ok) return { type: 'RELEASE_FAILED' };
    await recover({
      ledger: this.ledger,
      writers: this.releaseWriters(),
      client: this.client,
      retries: 0,
      backoff_s: [1],
      sleep: this.sleep,
      onlyRunId: this.state.runId,
    });
    return { type: 'RELEASE_OK' };
  }

  async maybeBoost() {
    const mode = this.config.logging.mode;
    if (mode !== 'period_boost' && mode !== 'both') return;
    const points = this.plan.sample_points.filter((point) => point.uuid).slice(0, this.config.logging.max_boosted_points);
    for (const point of points) {
      this.ledger.append({
        kind: 'period_intent',
        uuid: point.uuid,
        layer: point.layer,
        run_id: this.state.runId || 'pending',
        original_period: point.period || 300,
      });
    }
    if (points.length) {
      await this.client.upsertPoints(points.map((point) => ({
        uuid: point.uuid,
        layer: point.layer,
        period: this.config.logging.boost_period_s,
      })));
    }
  }

  interlockConfig() {
    return { ...this.config, _interlockCodes: this.plan.interlocks };
  }

  async readReadings() {
    this.unitFault = null;
    const ahuId = this.plan.equipment_id;
    const allowed = new Set((this.plan.sample_points || []).map((point) => `${point.equipment_id}|${point.role}`));
    /** @type {{ uuid: string, layer: string, role: string, equipmentId: string, unit: string | null }[]} */
    const refs = [];
    for (const [key, point] of this.points) {
      if (allowed.size > 0 && !allowed.has(key)) continue;
      const equipmentId = key.slice(0, key.indexOf('|'));
      refs.push({
        uuid: point.uuid,
        layer: point.layer,
        role: point.role,
        equipmentId,
        unit: point.unit || null,
      });
    }
    if (!refs.length) return {};
    let reply;
    try {
      reply = await this.client.readPoints(refs.map((point) => ({ uuid: point.uuid, layer: point.layer })));
    } catch {
      return null;
    }
    if (reply.errors && reply.errors.length) return null;
    /** @type {Record<string, { value: number | boolean | null, age_s: number }>} */
    const readings = {};
    const byUuid = new Map();
    for (const row of reply.results || []) {
      const stamped = Date.parse(row.ts);
      const fromClock = Number.isFinite(stamped) ? Math.max(0, (this.clock.now() - stamped) / 1000) : 0;
      byUuid.set(row.point.uuid, {
        value: parseScalar(row.scalar),
        age: Math.max(this.sampleAgeS || 0, fromClock),
      });
    }
    const zones = [];
    for (const point of refs) {
      if (!byUuid.has(point.uuid)) continue;
      const sample = byUuid.get(point.uuid);
      if (!sample) continue;
      let value = sample.value;
      const age = sample.age;
      const source = siUnitFor(point.role);
      if (source && point.unit && typeof value === 'number') {
        const converted = convertToSi(value, point.unit, source);
        if (!converted.ok) {
          const role = getRole(point.role);
          if (role && role.requirement === 'yes') this.unitFault = point.role;
          continue;
        }
        value = converted.value;
      }
      if (point.role === 'zone_air_temperature' && point.equipmentId !== ahuId) zones.push(value);
      else if (point.equipmentId === ahuId) readings[point.role] = { value, age_s: age };
    }
    if (zones.length) {
      const numbers = zones.filter((value) => typeof value === 'number').sort((a, b) => a - b);
      if (numbers.length) {
        readings.zone_air_temperature = {
          value: numbers[Math.floor((numbers.length - 1) / 2)],
          age_s: this.sampleAgeS || 0,
        };
      }
    }
    const maxAge = this.config.limits.max_sample_age_s;
    for (const point of refs) {
      if (point.equipmentId !== ahuId || readings[point.role]) continue;
      const role = getRole(point.role);
      if (role && role.requirement === 'yes') readings[point.role] = { value: null, age_s: maxAge + 1 };
    }
    return readings;
  }

  /**
   * @param {string} uuid
   * @returns {Promise<any[] | 'unreadable'>}
   */
  async readSlots(uuid) {
    const slots = await this.client.readPriorityArray({ uuid });
    return slots ? parsePriorityArray(slots) : 'unreadable';
  }

  async overrideConflict() {
    for (const entry of this.ownOverrides()) {
      if (entry.backend === 'dry_run' || entry.dry_run) continue;
      const slots = await this.readSlots(entry.uuid);
      if (slots === 'unreadable') return 'unreadable';
      for (let index = 0; index < entry.priority - 1; index += 1) {
        if (slots[index] !== null && slots[index] !== undefined) return 'conflict';
      }
      const ours = slots[entry.priority - 1];
      if (!slotMatches(ours, entry.value)) return 'conflict';
    }
    return 'ok';
  }
}

/**
 * @param {any} model
 */
function indexPoints(model) {
  const map = new Map();
  for (const equipment of model.equipment || []) {
    for (const point of Object.values(equipment.points || {})) {
      const typed = /** @type {any} */ (point);
      map.set(`${equipment.id}|${typed.role}`, typed);
    }
  }
  return map;
}

/**
 * @param {any} config
 * @param {string} stepId
 */
function holdMs(config, stepId) {
  const step = (config.plan.steps || []).find((item) => item.step_id === stepId);
  const minutes = step ? step.hold_minutes : 0;
  const scale = config.dry_run ? (config.dry_run_time_scale || 1) : 1;
  return Math.round((minutes * 60000) / scale);
}

/**
 * Settle time at the start of a step. Recorded for analysts and shown on the page; not enforced.
 * @param {any} config
 * @param {string} stepId
 */
function settleMs(config, stepId) {
  const step = (config.plan.steps || []).find((item) => item.step_id === stepId);
  const minutes = step && Number.isFinite(step.settle_minutes) ? step.settle_minutes : 0;
  const scale = config.dry_run ? (config.dry_run_time_scale || 1) : 1;
  return Math.round((minutes * 60000) / scale);
}

/**
 * @param {any} step
 * @param {any} config
 * @param {string} ahuId
 */
function expandWrites(step, config, ahuId) {
  if (step.step_id !== 'vav.max_cool') return (step.writes || []).slice();
  /** @type {any[]} */
  const writes = [];
  for (const box of step.boxes || []) {
    if (box.strategy === 'bas_toggle') {
      writes.push({
        role: 'maximum_cooling_operating_mode_command',
        value: config.vav_test.values.bas_toggle_on,
        equipment_id: ahuId,
      });
    } else if (box.strategy === 'flush_point') {
      writes.push({ role: 'purge_operating_mode_command', value: config.vav_test.values.flush_on, equipment_id: box.equipment_id });
    } else if (box.strategy === 'airflow_setpoint' && config.vav_test.airflow_setpoint_default_m3s !== null) {
      writes.push({
        role: 'discharge_air_volume_flow_rate_setpoint',
        value: config.vav_test.airflow_setpoint_default_m3s,
        equipment_id: box.equipment_id,
      });
    }
  }
  return writes;
}

/**
 * @param {any} plan
 * @param {any} config
 */
function runnableSteps(plan, config) {
  return (plan.steps || []).filter((step) => step.status === 'included').map((step) => ({
    step_id: step.step_id,
    writes: expandWrites(step, config, plan.equipment_id),
    preconditions: step.preconditions || [],
    hold_ms: holdMs(config, step.step_id),
    settle_ms: settleMs(config, step.step_id),
    boxes: step.boxes || [],
  }));
}

/**
 * @param {any} config
 */
function writerConfig(config) {
  return {
    dry_run: config.dry_run,
    backend: config.write.backend,
    bacnet_priority: config.write.bacnet_priority,
    command_lease_s: config.write.command_lease_s,
  };
}

/**
 * @param {unknown} raw
 */
function parseScalar(raw) {
  if (raw === true || raw === 'true' || raw === 'active') return true;
  if (raw === false || raw === 'false' || raw === 'inactive') return false;
  if (raw === '' || raw === null || raw === undefined) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : /** @type {number | boolean | null} */ (null);
}

module.exports = { Runner, runnableSteps };
