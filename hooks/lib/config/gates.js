'use strict';

/**
 * Live writes need both flags. Either one alone stays read-only.
 * @param {{ dry_run?: boolean } | null | undefined} config
 * @param {unknown} confirmLive
 * @returns {boolean}
 */
function liveWritesAllowed(config, confirmLive) {
  if (!config || typeof config !== 'object') return false;
  return config.dry_run === false && confirmLive === true;
}

module.exports = { liveWritesAllowed };
