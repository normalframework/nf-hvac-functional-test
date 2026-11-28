import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../static/rdf-source.js');

const rdf = (id) => ({ id, hooks: [{ id: 'rdf', name: 'rdf' }] });
const other = (id) => ({ id, hooks: [{ id: 'weather' }] });

test('rdf hook discovery prefers open-fdd, then lite, then any other rdf app', () => {
  assert.deepEqual(R.rdfAppIds([], 'nf-hvac-functional-test'), ['open-fdd', 'open-fdd-lite']);
  assert.deepEqual(R.rdfAppIds([other('open-fdd'), rdf('open-fdd-lite')], 'nf-hvac-functional-test'), ['open-fdd-lite']);
  assert.deepEqual(
    R.rdfAppIds([rdf('open-fdd'), rdf('open-fdd-lite'), rdf('custom-rdf')], 'nf-hvac-functional-test'),
    ['open-fdd', 'open-fdd-lite', 'custom-rdf'],
  );
  assert.ok(!R.rdfAppIds([rdf('nf-hvac-functional-test'), rdf('open-fdd-lite')], 'nf-hvac-functional-test').includes('nf-hvac-functional-test'));
  assert.equal(R.hasRdf(rdf('open-fdd-lite')), true);
  assert.equal(R.hasRdf(other('open-fdd')), false);
});
