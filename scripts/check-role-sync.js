'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertPinReady, assertSameRoleNames, readOpenfddPin, roleNames } = require('../hooks/lib/roles_sync');

const ROOT = path.join(__dirname, '..');

/**
 * @param {string} repo
 * @param {string} ref
 * @param {string} filePath
 */
async function fetchUpstream(repo, ref, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-FDD roles fetch failed ${response.status} ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const pin = assertPinReady(readOpenfddPin());
  const localPath = path.join(ROOT, pin.path);
  const localBytes = fs.readFileSync(localPath);
  const localHash = crypto.createHash('sha256').update(localBytes).digest('hex');
  if (localHash !== pin.sha256) {
    throw new Error(`Vendored roles sha256 ${localHash} does not match pin ${pin.sha256}`);
  }
  const local = JSON.parse(localBytes.toString('utf8'));
  if (local.version !== pin.version) {
    throw new Error(`Vendored roles version ${local.version} does not match pin ${pin.version}`);
  }
  const upstream = pin.upstream;
  const remoteBytes = await fetchUpstream(upstream.repo, upstream.ref, upstream.path);
  const remoteHash = crypto.createHash('sha256').update(remoteBytes).digest('hex');
  if (remoteHash !== pin.sha256) {
    throw new Error(`Open-FDD ${upstream.ref} sha256 ${remoteHash} does not match pin ${pin.sha256}`);
  }
  const remote = JSON.parse(remoteBytes.toString('utf8'));
  assertSameRoleNames(roleNames(local), roleNames(remote));
  if (remote.version !== pin.version) {
    throw new Error(`Open-FDD roles version ${remote.version} does not match pin ${pin.version}`);
  }
  console.log(`roles: pinned ${pin.version} at ${upstream.ref} (${local.roles.length} names). intended tag ${pin.intended_tag} is not flipped.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
