'use strict';

const COMMANDABLE = new Set(['ao', 'bo', 'mv']);

class DeviceObject {
  /**
   * @param {object} spec
   * @param {string} spec.uuid
   * @param {string} spec.layer
   * @param {'ao'|'ai'|'bo'|'bi'|'mv'} spec.type
   * @param {number | boolean | null} [spec.relinquish]
   * @param {string} [spec.unit]
   * @param {string} [spec.role]
   */
  constructor(spec) {
    this.uuid = spec.uuid;
    this.layer = spec.layer;
    this.type = spec.type;
    this.unit = spec.unit || '';
    this.role = spec.role || '';
    this.commandable = COMMANDABLE.has(spec.type);
    /** @type {(number | boolean | null)[]} */
    this.slots = Array(17).fill(null);
    this.relinquish = spec.relinquish !== undefined ? spec.relinquish : null;
    this.presentOverride = null;
    this.offline = false;
    /** @type {null | (() => number | boolean | null)} */
    this.derive = null;
    this.ignoreWrites = false;
    /** @type {Record<string, unknown>} */
    this.attrs = {};
  /** @type {number | undefined} */
  this.period = undefined;
  /** @type {string | undefined} */
  this.sampleTs = undefined;
  }

  presentValue() {
    if (this.derive) return this.derive();
    if (!this.commandable) {
      return this.presentOverride !== null && this.presentOverride !== undefined
        ? this.presentOverride
        : this.relinquish;
    }
    for (let priority = 1; priority <= 16; priority += 1) {
      const slot = this.slots[priority];
      if (slot !== null && slot !== undefined) return slot;
    }
    return this.relinquish;
  }

  /**
   * @param {number} priority
   * @param {number | boolean | null} value null relinquishes
   */
  writeAt(priority, value) {
    if (!this.commandable) throw coded('object is not commandable', 'not_commandable');
    if (!Number.isInteger(priority) || priority < 1 || priority > 16) {
      throw coded('priority out of range', 'priority');
    }
    if (this.ignoreWrites && value !== null) {
      return { ignored: true };
    }
    const previous = this.slots[priority];
    this.slots[priority] = value;
    if (this.ignoreWrites) this.slots[priority] = previous;
    return { ignored: this.ignoreWrites, previous };
  }

  priorityArray() {
    if (!this.commandable) return null;
    return this.slots.slice(1);
  }
}

/**
 * @param {string} message
 * @param {string} code
 */
function coded(message, code) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}

module.exports = { DeviceObject };
