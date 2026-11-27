'use strict';

class DryRunWriter {
  /**
   * @param {InstanceType<typeof import('../ledger').Ledger>} ledger
   */
  constructor(ledger) {
    this.ledger = ledger;
    this.backend = 'dry_run';
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
      priority: spec.priority,
      value: spec.value,
      backend: 'dry_run',
      dry_run: true,
    };
    this.ledger.append({ ...base, kind: 'intent' });
    this.ledger.append({ ...base, kind: 'active', would_write: true });
    return { ok: true, dry_run: true };
  }

  /**
   * @param {any[]} entries
   */
  async release(entries) {
    const live = entries.filter((entry) => entry.backend && entry.backend !== 'dry_run');
    if (live.length) {
      const error = /** @type {Error & { code: string }} */ (new Error('dry_run writer cannot release a live override'));
      error.code = 'dry_run_release_refused';
      throw error;
    }
    return { verified: entries, failed: [] };
  }

  /**
   * @param {any} spec
   */
  async extend(spec, _newExpiration) {
    return { ok: true, dry_run: true, spec };
  }
}

module.exports = { DryRunWriter };
