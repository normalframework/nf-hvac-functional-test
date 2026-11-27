'use strict';

const SCHEDULED = new Set(['MODE_SCHEDULED']);
const REQUEST = new Set(['MODE_ON_REQUEST']);

/**
 * A bare RRULE line, or DTSTART on its own line followed by the RRULE line.
 * @param {unknown} rule
 */
function validRule(rule) {
  if (typeof rule !== 'string') return false;
  if (rule.startsWith('RRULE:')) return !rule.includes('\n');
  const lines = rule.split('\n');
  return lines.length === 2 && /^DTSTART[:;]/.test(lines[0]) && lines[1].startsWith('RRULE:');
}

/**
 * The definition shape from the NF hooks guide.
 * @param {any} doc
 * @param {'scheduled' | 'request'} kind
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
function validateHook(doc, kind) {
  /** @type {string[]} */
  const errors = [];
  const hook = doc && doc.hook;
  if (!hook || typeof hook !== 'object') return { ok: false, errors: ['hook'] };
  if (typeof hook.name !== 'string' || !hook.name) errors.push('hook.name');
  if (typeof hook.entryPoint !== 'string' || !hook.entryPoint) errors.push('hook.entryPoint');
  if (kind === 'scheduled') {
    if (!SCHEDULED.has(hook.mode)) errors.push('hook.mode');
    const rule = hook.schedule && hook.schedule.rrule;
    if (!validRule(rule)) errors.push('hook.schedule.rrule');
    if (!Array.isArray(hook.globalVariables) || hook.globalVariables.some((item) => !item || typeof item.label !== 'string')) {
      errors.push('hook.globalVariables');
    }
  } else if (!REQUEST.has(hook.mode)) errors.push('hook.mode');
  if (typeof hook.invokeTimeout !== 'string' || !/^\d+s$/.test(hook.invokeTimeout)) errors.push('hook.invokeTimeout');
  return errors.length ? { ok: false, errors } : { ok: true };
}

module.exports = { validateHook };
