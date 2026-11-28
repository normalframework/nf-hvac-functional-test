'use strict';

const { createHash } = require('node:crypto');

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * @param {string} name
 */
function shadowUuid(name) {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class Sampler {
  /**
   * @param {{ client: InstanceType<typeof import('./nf/client').NfClient>, layer?: string }} options
   */
  constructor(options) {
    this.client = options.client;
    this.layer = options.layer || 'hpl:bacnet:1';
    /** @type {{ ts: number, step_index: number, step_id: string, values: Record<string, number | boolean | null> }[]} */
    this.series = [];
    this.prepared = false;
  }

  /**
   * @param {{ ts: number, step_index: number, step_id: string, run_seq: number, values: Record<string, number | boolean | null> }} sample
   */
  async record(sample) {
    this.series.push({
      ts: sample.ts,
      step_index: sample.step_index,
      step_id: sample.step_id,
      values: sample.values,
    });
    const stepPoint = shadowUuid(`ftest_step_index:${sample.run_seq}`);
    const seqPoint = shadowUuid('ftest_run_seq');
    if (!this.prepared) {
      await this.client.upsertPoints([
        { uuid: stepPoint, name: 'ftest_step_index', layer: 'ftest', attrs: { role: 'ftest_step_index', kind: 'Number', unit: '' } },
        { uuid: seqPoint, name: 'ftest_run_seq', layer: 'ftest', attrs: { role: 'ftest_run_seq', kind: 'Number', unit: '' } },
      ]);
      this.prepared = true;
    }
    await this.client.addData({
      batches: [
        { uuid: stepPoint, values: [{ ts: new Date(sample.ts).toISOString(), value: sample.step_index }] },
        { uuid: seqPoint, values: [{ ts: new Date(sample.ts).toISOString(), value: sample.run_seq }] },
      ],
    });
  }
}

module.exports = { Sampler, shadowUuid };
