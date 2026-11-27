'use strict';

const { liveWritesAllowed } = require('../config/gates');
const { DryRunWriter } = require('./dry_run');
const { NfCommandWriter } = require('./nf_command');
const { BacnetDirectWriter } = require('./bacnet_direct');

/**
 * @param {{ config: any, confirmLive?: boolean, client: InstanceType<typeof import('../nf/client').NfClient>, ledger: InstanceType<typeof import('../ledger').Ledger> }} options
 */
function createWriter(options) {
  const { config, ledger } = options;
  if (!liveWritesAllowed(config, options.confirmLive === true)) return new DryRunWriter(ledger);
  if (config.backend === 'bacnet_direct') {
    return new BacnetDirectWriter({
      client: options.client,
      ledger,
      priority: config.bacnet_priority,
    });
  }
  return new NfCommandWriter({
    client: options.client,
    ledger,
    priority: config.bacnet_priority,
    duration_s: config.command_lease_s,
  });
}

/**
 * Writers for release. The live-write gate does not apply: each ledger entry
 * is released by the backend that wrote it.
 * @param {{ config: any, client: InstanceType<typeof import('../nf/client').NfClient>, ledger: InstanceType<typeof import('../ledger').Ledger> }} options
 */
function createReleaseWriters(options) {
  /** @type {Record<string, any>} */
  const writers = {};
  const backends = new Set(options.ledger.openOverrides().map((entry) => entry.backend || 'nf_command'));
  for (const backend of backends) {
    if (backend === 'dry_run') writers.dry_run = new DryRunWriter(options.ledger);
    else if (backend === 'bacnet_direct') {
      writers.bacnet_direct = new BacnetDirectWriter({
        client: options.client,
        ledger: options.ledger,
        priority: options.config.bacnet_priority,
      });
    } else if (backend === 'nf_command') {
      writers.nf_command = new NfCommandWriter({
        client: options.client,
        ledger: options.ledger,
        priority: options.config.bacnet_priority,
        duration_s: options.config.command_lease_s,
      });
    }
  }
  return writers;
}

module.exports = { createWriter, createReleaseWriters };
