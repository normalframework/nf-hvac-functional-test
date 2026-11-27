'use strict';

/**
 * A box "responds" when its airflow moved. Too few responders is no_effect.
 * @param {{ responding: number, total: number, minimumPct: number }} spec
 */
function basToggleEffect(spec) {
  if (spec.total <= 0) return { ok: false, reason: 'insufficient_capability' };
  const pct = (100 * spec.responding) / spec.total;
  if (pct < spec.minimumPct) return { ok: false, reason: 'no_effect' };
  return { ok: true, reason: null, pct };
}

module.exports = { basToggleEffect };
