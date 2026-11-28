import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Trigger = require('../static/trigger.js');
const { writeTrigger } = require('../hooks/lib/trigger_store');
const { readState, writeState } = require('../hooks/lib/persist');
const { runTrigger } = require('../hooks/lib/trigger_run');

const CHI = 'America/Chicago';
const NOON = Date.parse('2026-11-26T18:00:00Z');
const rule = { kind: 'monthly_last', weekday: 3, hour: 12, minute: 0, tz: CHI };

test('runTrigger queues staggered system starts and promotes the first due item', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nfft-tr-'));
  try {
    writeTrigger(root, Trigger.normalize({
      mode: 'dry_run',
      rule,
      scope: 'systems',
      system_ids: ['ahu-1', 'ahu-2'],
      stagger_minutes: 15,
    }));
    writeState(root, {});
    const out = await runTrigger({ root }, { now: NOON });
    assert.equal(out.action, 'start');
    assert.equal(out.queued, 2);
    const saved = readState(root);
    assert.equal(saved.pending_start.system_id, 'ahu-1');
    assert.equal(saved.pending_start.start_at, NOON);
    assert.equal(saved.pending_queue.length, 1);
    assert.equal(saved.pending_queue[0].system_id, 'ahu-2');
    assert.equal(saved.pending_queue[0].start_at, NOON + 15 * 60 * 1000);
    const again = await runTrigger({ root }, { now: NOON + 1000 });
    assert.equal(again.reason, 'already_handled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
