'use strict';

/**
 * Status the operator page can render. A failed fetch is not a dry run.
 * @param {{ ok?: boolean, json?: () => Promise<any> } | null} reply
 */
async function readStatus(reply) {
  if (!reply || reply.ok !== true || typeof reply.json !== 'function') {
    return { state: 'status unknown', dry_run: null, show_dry_run: false, unknown: true };
  }
  const body = await reply.json();
  return {
    state: body.state || 'IDLE',
    step: body.step || 'none',
    time_left: body.time_left || '0 s',
    overrides: body.overrides || 'none',
    interlocks: body.interlocks || 'none',
    release: body.release || 'idle',
    capability: body.capability || 'none',
    dry_run: body.dry_run,
    show_dry_run: body.dry_run === true,
    unknown: false,
  };
}

function abortRequest() {
  return {
    url: '/api/v1/hooks/admin/invoke',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { args: { action: 'abort' } },
  };
}

/**
 * @param {{ ok?: boolean, json?: () => Promise<any> } | null} reply
 */
async function readAbort(reply) {
  if (!reply || reply.ok !== true || typeof reply.json !== 'function') {
    return { release: 'abort failed', error: 'status unknown' };
  }
  const body = await reply.json();
  if (body.ok === false) return { release: 'abort failed', error: body.code || 'error' };
  return { release: body.state || 'RELEASING', error: '' };
}

module.exports = { readStatus, abortRequest, readAbort };
