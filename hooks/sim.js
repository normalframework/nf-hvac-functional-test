'use strict';

const { run } = require('./lib/sim');

/**
 * Optional local-object simulator. No-op unless enableSimulator is true and
 * simulatorConfirm is CREATE_LOCAL_SIM. See docs/SIMULATOR.md.
 * @param {any} ctx
 */
async function onTick(ctx) {
  const sdk = ctx && ctx.sdk ? ctx.sdk : (ctx || {});
  return run(sdk, { options: sdk.options || (ctx && ctx.options) || {} });
}

module.exports = onTick;
