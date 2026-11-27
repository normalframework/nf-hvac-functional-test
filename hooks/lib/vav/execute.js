'use strict';

const { airflowTarget } = require('./airflow_setpoint');
const { deviceNumber } = require('../units');
const { guardWrite } = require('../writers/guard');
const { flushEffective } = require('./flush_point');
const { basToggleEffect } = require('./bas_toggle');

/**
 * Write capable boxes in batches. VAV equipment is returned ahead of the AHU
 * so a later release cancels boxes first.
 * @param {any} options
 */
async function executeVav(options) {
  const { step, config, writer, runId, sleep, readSlot, readNumber, pointFor } = options;
  const boxes = (step.boxes || []).filter((box) => box.strategy);
  /** @type {any[]} */
  const report = [];
  const batchSize = Math.max(1, config.vav_test.batch_size);
  const delayMs = config.vav_test.batch_delay_s * 1000;
  let failed = false;

  const toggles = boxes.filter((box) => box.strategy === 'bas_toggle');
  const perBox = boxes.filter((box) => box.strategy !== 'bas_toggle');
  if (toggles.length) {
    const before = [];
    for (const box of toggles) before.push(await readNumber(box.equipment_id, 'discharge_air_volume_flow_rate'));
    const point = pointFor(options.ahuId, 'maximum_cooling_operating_mode_command');
    const value = config.vav_test.values.bas_toggle_on;
    const wrote = await writeOne(writer, runId, options.ahuId, point, value);
    const after = [];
    for (const box of toggles) after.push(await readNumber(box.equipment_id, 'discharge_air_volume_flow_rate'));
    let responding = 0;
    for (let index = 0; index < toggles.length; index += 1) {
      if (after[index] !== null && before[index] !== null && after[index] !== before[index]) responding += 1;
    }
    const effect = basToggleEffect({
      responding,
      total: toggles.length,
      minimumPct: config.vav_test.bas_toggle_min_boxes_responding_pct,
    });
    for (const box of toggles) {
      report.push({ equipment_id: box.equipment_id, strategy: 'bas_toggle', reason: effect.reason });
    }
    if (!wrote.ok || !effect.ok) failed = true;
  }

  const start = options.startIndex || 0;
  for (let index = start; index < perBox.length; index += batchSize) {
    const batch = perBox.slice(index, index + batchSize);
    for (const box of batch) {
      const outcome = await writeBox(box);
      report.push(outcome);
      if (outcome.reason) failed = true;
    }
    if (index + batchSize < perBox.length) {
      if (options.pace) return { ok: !failed, report, incomplete: true, nextIndex: index + batchSize };
      await sleep(delayMs);
    }
  }
  return { ok: !failed, report };

  /**
   * @param {any} box
   */
  async function writeBox(box) {
    if (box.strategy === 'flush_point') {
      const point = pointFor(box.equipment_id, 'purge_operating_mode_command');
      const value = config.vav_test.values.flush_on;
      const wrote = await writeOne(writer, runId, box.equipment_id, point, value);
      if (!wrote.ok) return { equipment_id: box.equipment_id, strategy: box.strategy, reason: wrote.reason };
      const slot = await readSlot(point.uuid);
      const effect = flushEffective({ flush: value, readback: slot });
      return { equipment_id: box.equipment_id, strategy: box.strategy, reason: effect.reason };
    }
    const maximum = await readNumber(box.equipment_id, 'discharge_air_volume_flow_rate_maximum');
    const target = airflowTarget({
      maximum,
      fallback: config.vav_test.airflow_setpoint_default_m3s,
      hardCap: config.vav_test.airflow_setpoint_hard_cap_m3s,
    });
    if (!target.ok || target.value === undefined) {
      return { equipment_id: box.equipment_id, strategy: box.strategy, reason: target.reason || 'airflow_not_positive' };
    }
    const point = pointFor(box.equipment_id, 'discharge_air_volume_flow_rate_setpoint');
    const wrote = await writeOne(writer, runId, box.equipment_id, point, target.value);
    if (!wrote.ok) return { equipment_id: box.equipment_id, strategy: box.strategy, reason: wrote.reason };
    const slot = await readSlot(point.uuid);
    if (slot !== target.value) {
      return { equipment_id: box.equipment_id, strategy: box.strategy, reason: 'write_not_effective' };
    }
    return { equipment_id: box.equipment_id, strategy: box.strategy, reason: null };
  }
}

/**
 * @param {any} writer
 * @param {string} runId
 * @param {string} equipmentId
 * @param {any} point
 * @param {number | boolean} value
 */
async function writeOne(writer, runId, equipmentId, point, value) {
  if (!point) return { ok: false, reason: 'role_unbound' };
  const guarded = guardWrite(point, value, null);
  if (!guarded.ok) return { ok: false, reason: guarded.reason };
  const native = deviceNumber(point, value);
  if (!native.ok) return { ok: false, reason: native.reason };
  const result = await writer.write({
    run_id: runId,
    equipment_id: equipmentId,
    uuid: point.uuid,
    layer: point.layer,
    value: native.value,
  });
  if (!result.ok) return { ok: false, reason: result.error || 'write_failed' };
  return { ok: true, reason: null };
}

/**
 * Boxes first, then the AHU, stable within each group.
 * @param {any[]} entries
 * @param {string} ahuId
 */
function orderRelease(entries, ahuId) {
  return entries.slice().sort((left, right) => {
    const leftAhu = left.equipment_id === ahuId ? 1 : 0;
    const rightAhu = right.equipment_id === ahuId ? 1 : 0;
    if (leftAhu !== rightAhu) return leftAhu - rightAhu;
    return String(left.equipment_id).localeCompare(String(right.equipment_id));
  });
}

module.exports = { executeVav, orderRelease };
