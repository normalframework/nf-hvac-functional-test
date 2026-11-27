'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { RoleFilePinError } = require('./errors');

const PIN_REL = 'schema/shared-role-file.pin.json';
const OXIGRAPH_VERSION = '0.5.13';

/**
 * @param {string} root
 */
function readPin(root) {
  return JSON.parse(fs.readFileSync(path.join(root, PIN_REL), 'utf8'));
}

/**
 * The shared role file is absent until its sha256 is pinned.
 * A file whose hash differs from the pin fails closed.
 * @param {string} root
 */
function checkVendoredRoleFile(root) {
  const pin = readPin(root);
  if (pin.oxigraph !== OXIGRAPH_VERSION) {
    throw new RoleFilePinError('oxigraph_pin', `Oxigraph pin must be ${OXIGRAPH_VERSION}`);
  }
  const file = path.join(root, String(pin.path || ''));
  if (!fs.existsSync(file)) {
    if (pin.sha256 !== null && pin.sha256 !== undefined) {
      throw new RoleFilePinError('role_file_missing', 'Pinned role file is not in the tree');
    }
    return { vendored: false, sha256: null };
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (typeof pin.sha256 !== 'string' || hash !== pin.sha256) {
    throw new RoleFilePinError(
      'role_file_hash_mismatch',
      'Vendored role file sha256 does not match the pin',
    );
  }
  return { vendored: true, sha256: hash };
}

module.exports = {
  PIN_REL,
  OXIGRAPH_VERSION,
  readPin,
  checkVendoredRoleFile,
  RoleFilePinError,
};
