'use strict';

const { run } = require('./lib/sim');
const { defaultStateRoot } = require('./lib/runtime');

/**
 * Optional local-object simulator. No-op unless enableSimulator is true and
 * simulatorConfirm is CREATE_LOCAL_SIM. See docs/SIMULATOR.md.
 * NF scheduled hooks receive app options as ctx.config (flat scalars or
 * {boolean|string|number} wrappers), not sdk.options.
 * @param {any} ctx
 */
async function onTick(ctx) {
  const sdk = ctx && ctx.sdk ? ctx.sdk : (ctx || {});
  const options = Object.assign(
    {},
    sdk.options || {},
    (ctx && ctx.options) || {},
    sdk.config || {},
    (ctx && ctx.config) || {},
  );
  const http = sdk.http || (ctx && ctx.http);
  return run(sdk, { options, http, stateRoot: defaultStateRoot() });
}

module.exports = onTick;
