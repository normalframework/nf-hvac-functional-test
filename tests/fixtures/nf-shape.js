'use strict';

// Shape comparison for the recorded-NF contract tests: same JSON types (an int64 is a STRING in NF's JSON),
// free-form maps compared loosely. Returns a list of problems, empty when the shapes match.
const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/**
 * @param {any} actual what the fake sent
 * @param {any} expected what real NF sent (a recording)
 * @param {{ free?: string[], optional?: string[], ignore?: string[], subset?: boolean }} [opts]
 *   free: keys holding a free-form map; optional: keys that may be absent; ignore: keys skipped;
 *   subset: the fake may omit keys real NF sends (it may never send a key real NF does not).
 * @param {string} [at]
 * @returns {string[]}
 */
function shapeProblems(actual, expected, opts = {}, at = '$') {
  const free = new Set(opts.free || ['attrs', 'args', 'stats']);
  const optional = new Set(opts.optional || []);
  const ignore = new Set(opts.ignore || []);
  const ka = kind(actual);
  const ke = kind(expected);
  if (ka !== ke) return [`${at}: ${ka}, NF sends ${ke}`];
  if (ke === 'array') {
    if (!expected.length || !actual.length) return [];
    return actual.flatMap((item, i) => {
      const tries = expected.map((e) => shapeProblems(item, e, opts, `${at}[${i}]`));
      return tries.some((t) => t.length === 0) ? [] : tries.reduce((a, b) => (b.length < a.length ? b : a));
    });
  }
  if (ke !== 'object') return [];
  const out = [];
  for (const key of Object.keys(expected)) {
    if (ignore.has(key)) continue;
    if (!(key in actual)) {
      if (!optional.has(key) && !opts.subset) out.push(`${at}.${key}: missing (NF sends it)`);
      continue;
    }
    if (free.has(key)) {
      if (kind(actual[key]) !== 'object') out.push(`${at}.${key}: ${kind(actual[key])}, NF sends a map`);
      continue;
    }
    out.push(...shapeProblems(actual[key], expected[key], opts, `${at}.${key}`));
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected) && !ignore.has(key) && !optional.has(key)) out.push(`${at}.${key}: NF does not send it`);
  }
  return out;
}

module.exports = { shapeProblems };
