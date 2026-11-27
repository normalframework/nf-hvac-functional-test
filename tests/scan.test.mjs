import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanText, scanRepo, loadWords } = require('../scripts/scan-forbidden');

test('scanner flags a supplied token without embedding the denylist', () => {
  const words = loadWords(require('node:path').join(__dirname, '..', '.github', 'forbidden-words.txt'));
  assert.ok(words.length >= 4);
  const sample = `note ${words[0]} here`;
  const hits = scanText(sample, words);
  assert.equal(hits.some((hit) => hit.kind === 'forbidden_word' && hit.detail === words[0]), true);
  assert.equal(scanText('ahu_a vav_01', words).length, 0);
});

test('scanner flags secret shapes', () => {
  const accessKey = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
  const hits = scanText(`key ${accessKey} extra`, []);
  assert.equal(hits.some((hit) => hit.detail === 'aws_access_key'), true);
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  const key = scanText(`${header}\n`, []);
  assert.equal(key.some((hit) => hit.detail === 'private_key'), true);
});

test('repository scan is clean', () => {
  const hits = scanRepo();
  assert.deepEqual(hits, []);
});
