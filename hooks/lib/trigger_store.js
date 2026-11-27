'use strict';

const path = require('node:path');
const { readJson, writeJsonAtomic } = require('./persist');
const Trigger = require('../../static/trigger.js');

/**
 * @param {string} root
 */
function triggerFile(root) {
  return path.join(root, 'trigger.json');
}

/**
 * The stored trigger document. A missing or corrupt file is the disabled default.
 * @param {string} root
 */
function readTrigger(root) {
  return Trigger.normalize(readJson(triggerFile(root)));
}

/**
 * @param {string} root
 * @param {any} doc
 */
function writeTrigger(root, doc) {
  writeJsonAtomic(triggerFile(root), Trigger.normalize(doc));
}

module.exports = { triggerFile, readTrigger, writeTrigger };
