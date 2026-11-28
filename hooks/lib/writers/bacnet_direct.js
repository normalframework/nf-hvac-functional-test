'use strict';

const { relinquishIfOurs } = require('./verify');
const { errorText } = require('../nf/client');

class BacnetDirectWriter {
  /**
   * @param {{ client: InstanceType<typeof import('../nf/client').NfClient>, ledger: InstanceType<typeof import('../ledger').Ledger>, priority: number }} options
   */
  constructor(options) {
    this.client = options.client;
    this.ledger = options.ledger;
    this.priority = options.priority;
    this.backend = 'bacnet_direct';
  }

  /**
   * @param {any} spec
   */
  async write(spec) {
    const base = {
      run_id: spec.run_id,
      equipment_id: spec.equipment_id,
      uuid: spec.uuid,
      layer: spec.layer,
      priority: this.priority,
      value: spec.value,
      backend: 'bacnet_direct',
    };
    this.ledger.append({ ...base, kind: 'intent' });
    const reply = await this.client.bacnetWrite({
      uuid: spec.uuid,
      priority: this.priority,
      value: spec.value,
    });
    if (reply.errors && reply.errors.length) {
      this.ledger.append({ ...base, kind: 'failed', sent: true, error: errorText(reply.errors[0].error) });
      return { ok: false, error: errorText(reply.errors[0].error) };
    }
    this.ledger.append({ ...base, kind: 'active', sent: true });
    return { ok: true };
  }

  /**
   * @param {any[]} entries
   */
  async release(entries) {
    /** @type {any[]} */
    const verified = [];
    /** @type {any[]} */
    const failed = [];
    for (const entry of entries) {
      this.ledger.append({
        kind: 'release_intent',
        run_id: entry.run_id,
        equipment_id: entry.equipment_id,
        uuid: entry.uuid,
        layer: entry.layer,
        priority: entry.priority,
        backend: 'bacnet_direct',
      });
      const outcome = await relinquishIfOurs(this.client, entry);
      if (outcome === 'released' || outcome === 'empty') verified.push(entry);
      else failed.push({ ...entry, release_error: outcome });
    }
    return { verified, failed };
  }
}

module.exports = { BacnetDirectWriter };
