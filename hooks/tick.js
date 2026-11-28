'use strict';

const { tick, bindRelease, createSession } = require('./lib/admin');
const { ensureRuntime } = require('./lib/runtime');

/** @type {any} */
let session = createSession();
let signalsBound = false;

/**
 * NF calls this with the applications SDK. The SDK is not required at load time.
 * @param {any} ctx
 */
async function onTick(ctx) {
  const sdk = ctx && ctx.sdk ? ctx.sdk : (ctx || {});
  if (ctx && Array.isArray(ctx.globalVariables)) sdk.globalVariables = ctx.globalVariables;
  if (ctx && ctx.sdk && ctx.config && !sdk.config) sdk.config = ctx.config;
  ensureRuntime(session, sdk);
  if (!signalsBound) {
    bindRelease(sdk, () => {
      if (session.runner && typeof session.runner.abort === 'function') return session.runner.abort();
      return undefined;
    });
    if (typeof process.once === 'function') {
      process.once('SIGTERM', () => {
        const pending = session.runner && typeof session.runner.abort === 'function'
          ? session.runner.abort()
          : Promise.resolve();
        const timer = setTimeout(() => {}, 2000);
        if (typeof timer.unref === 'function') timer.unref();
        Promise.race([Promise.resolve(pending), new Promise((resolve) => setTimeout(resolve, 2000))]).catch(() => {});
      });
    }
    signalsBound = true;
  }
  return tick(sdk, session);
}

onTick.useSession = (next) => {
  session = next;
};

module.exports = onTick;
