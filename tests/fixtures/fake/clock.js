'use strict';

class VirtualClock {
  /**
   * @param {number} [startMs]
   */
  constructor(startMs = 0) {
    this.ms = startMs;
    /** @type {((now: number) => void)[]} */
    this.listeners = [];
  }

  now() {
    return this.ms;
  }

  iso() {
    return new Date(this.ms).toISOString();
  }

  /**
   * @param {number} deltaMs
   */
  advance(deltaMs) {
    this.ms += deltaMs;
    for (const listener of this.listeners) listener(this.ms);
  }

  /**
   * @param {(now: number) => void} listener
   */
  onAdvance(listener) {
    this.listeners.push(listener);
  }
}

module.exports = { VirtualClock };
