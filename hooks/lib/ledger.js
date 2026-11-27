'use strict';

const fs = require('node:fs');
const path = require('node:path');

class Ledger {
  /**
   * @param {string} dir
   * @param {{ warn?: (message: string) => void }} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'ledger.jsonl');
    this.warn = options.warn || (() => {});
    this.seq = 0;
    fs.mkdirSync(dir, { recursive: true });
    for (const record of this.readRecords().records) {
      if (typeof record.seq === 'number' && record.seq > this.seq) this.seq = record.seq;
    }
  }

  /**
   * @param {Record<string, unknown>} record
   */
  append(record) {
    this.seq += 1;
    const line = `${JSON.stringify({ seq: this.seq, ...record })}\n`;
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return this.seq;
  }

  readRecords() {
    if (!fs.existsSync(this.file)) return { records: [], corrupt: false };
    const text = fs.readFileSync(this.file, 'utf8');
    if (!text) return { records: [], corrupt: false };
    const lines = text.split('\n');
    let corrupt = false;
    if (!text.endsWith('\n')) {
      corrupt = true;
      this.warn('corrupt ledger tail ignored');
      lines.pop();
    }
    /** @type {any[]} */
    const records = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        corrupt = true;
        this.warn('corrupt ledger line ignored');
      }
    }
    return { records, corrupt };
  }

  openOverrides() {
    /** @type {Map<string, { held: boolean, record: any }>} */
    const slots = new Map();
    for (const record of this.readRecords().records) {
      if (!record.uuid || record.kind === 'period_intent' || record.kind === 'period_restored') continue;
      const key = `${record.run_id}|${record.uuid}|${record.priority}`;
      const slot = slots.get(key) || { held: false, record: null };
      if (record.kind === 'active') {
        slots.set(key, { held: true, record });
      } else if (record.kind === 'intent') {
        if (!slot.held) slots.set(key, { held: false, record });
      } else if (record.kind === 'failed') {
        if (!slot.held) slots.delete(key);
      } else if (record.kind === 'released') {
        slots.delete(key);
      }
    }
    return [...slots.values()].map((slot) => slot.record).filter(Boolean);
  }

  openPeriods() {
    /** @type {Map<string, any>} */
    const open = new Map();
    for (const record of this.readRecords().records) {
      if (record.kind === 'period_intent') open.set(record.uuid, record);
      if (record.kind === 'period_restored') open.delete(record.uuid);
    }
    return [...open.values()];
  }

  snapshot() {
    const payload = JSON.stringify({ records: this.readRecords().records });
    const tmp = path.join(this.dir, 'ledger.snapshot.json.tmp');
    const dest = path.join(this.dir, 'ledger.snapshot.json');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dest);
    return dest;
  }
}

module.exports = { Ledger };
