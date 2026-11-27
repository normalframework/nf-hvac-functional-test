import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releaseEntries } = require('../hooks/lib/writers/release');

test('a paced release waits for the next tick instead of sleeping', async () => {
  let slept = false;
  const result = await releaseEntries({
    ledger: /** @type {any} */ ({ append() {} }),
    entries: [{ run_id: 'r', equipment_id: 'ahu_a', uuid: 'u', layer: 'hpl:bacnet:1', priority: 8, value: 0, backend: 'nf_command' }],
    retries: 3,
    backoff_s: [5],
    once: true,
    sleep: async () => { slept = true; },
    writer: { async release() { return { verified: [], failed: [{ run_id: 'r' }] }; } },
  });
  assert.equal(slept, false);
  assert.equal(result.deferred, true);
  assert.equal(result.wait_ms, 5000);
});
