'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Next monotonic run counter for this install. The file is replaced
 * after fsync so a crash cannot hand the same number out twice.
 * @param {string} root
 */
function allocateRunSeq(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'run_seq');
  let current = 0;
  if (fs.existsSync(file)) {
    const parsed = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (Number.isInteger(parsed) && parsed > 0) current = parsed;
  }
  const next = current + 1;
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${next}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return next;
}

module.exports = { allocateRunSeq };
