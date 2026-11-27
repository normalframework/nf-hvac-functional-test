import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ulid, isUlid } = require('../hooks/lib/ulid');
const { adminAction, createSession } = require('../hooks/lib/admin');

test('generated run ids are ULIDs and sort by time', async () => {
  const early = ulid(Date.parse('2026-01-01T00:00:00Z'));
  const later = ulid(Date.parse('2026-01-01T00:00:01Z'));
  assert.equal(isUlid(early), true);
  assert.equal(early < later, true);
  assert.equal(isUlid('run_operator'), false);
  const session = createSession();
  session.factory = async () => ({
    state: { phase: 'IDLE', stepIndex: -1, runId: '', needsAttention: false },
    manifest: { overrides: [], dry_run: true },
    attention: 0,
    async start(id) { this.state.phase = 'PRECHECK'; this.state.runId = id; },
  });
  const started = await adminAction(session, 'start', { confirm_live: true });
  assert.equal(isUlid(started.run_id), true);
});
