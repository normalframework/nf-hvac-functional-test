import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../hooks/lib/sim');
const onTick = require('../hooks/sim');

function listing(objects) {
  return {
    objects: objects.map((o) => ({
      objectId: { objectType: o.objectType || 'OBJECT_ANALOG_VALUE', instance: o.instance },
      props: [{ property: 'PROP_OBJECT_NAME', value: { characterString: o.name } }],
    })),
  };
}

function mockHttp(state) {
  state.posts = [];
  state.patches = [];
  state.gets = [];
  state.upserts = [];
  state.local = listing(state.existing || []);
  state.configOk = state.configOk !== false;
  return {
    async get(url) {
      state.gets.push(url);
      if (url === '/api/v1/bacnet/configuration') {
        if (!state.configOk) {
          const err = new Error('not found');
          err.status = 404;
          throw err;
        }
        return { data: { enabled: true }, status: 200 };
      }
      if (url === '/api/v1/bacnet/local') return { data: state.local, status: 200 };
      throw new Error('unexpected GET ' + url);
    },
    async post(url, body) {
      if (url === '/api/v1/bacnet/local') {
        assert.equal(Object.prototype.hasOwnProperty.call(body, 'uuid'), false, 'create must not send uuid');
        state.posts.push(body);
        return { data: { ok: true }, status: 200 };
      }
      if (url === '/api/v1/point/query') {
        state.queries = (state.queries || []).concat([body]);
        return { data: { totalCount: String(state.modelCount === undefined ? 0 : state.modelCount) }, status: 200 };
      }
      if (url === '/api/v1/point/points') {
        state.upserts.push(body);
        return { data: { ok: true }, status: 200 };
      }
      throw new Error('unexpected POST ' + url);
    },
    async patch(url, body) {
      assert.equal(url, '/api/v1/bacnet/local');
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'uuid'), false);
      state.patches.push(body);
      return { data: { ok: true }, status: 200 };
    },
  };
}

test('catalog is built from the demo fixture with prefixed ids and no demo uuids', () => {
  const cat = Sim.catalog();
  assert.ok(cat.points.length >= 100);
  assert.ok(cat.equipment.some((e) => e.id === 'nfft-sim-ahu-1'));
  assert.ok(cat.equipment.some((e) => e.id === 'nfft-sim-ahu-2' && !e.airRef));
  const vav1 = cat.equipment.find((e) => e.id === 'nfft-sim-vav-01');
  assert.equal(vav1.airRef, 'nfft-sim-ahu-1');
  const loose = cat.equipment.find((e) => e.id === 'nfft-sim-vav-99');
  assert.ok(loose && !loose.airRef);
  const pump = cat.equipment.find((e) => e.id === 'nfft-sim-hw-pump-1');
  assert.equal(pump.feeds, 'nfft-sim-ahu-1');
  assert.ok(cat.points.every((p) => p.name.startsWith('nfft-sim.')));
  assert.ok(cat.points.every((p) => !('uuid' in p) || p.uuid === undefined));
});

test('isArmed requires the option and the exact confirm phrase', () => {
  assert.equal(Sim.isArmed({}), false);
  assert.equal(Sim.isArmed({ enableSimulator: true }), false);
  assert.equal(Sim.isArmed({ enableSimulator: true, simulatorConfirm: 'please' }), false);
  assert.equal(Sim.isArmed({ enableSimulator: true, simulatorConfirm: Sim.CONFIRM_PHRASE }), true);
  assert.equal(Sim.isArmed({ enableSimulator: 'true', simulatorConfirm: ' CREATE_LOCAL_SIM ' }), true);
  assert.equal(Sim.isArmed({
    enableSimulator: { boolean: true },
    simulatorConfirm: { string: Sim.CONFIRM_PHRASE },
  }), true);
  assert.equal(Sim.isArmed({
    enableSimulator: { boolean: false },
    simulatorConfirm: { string: Sim.CONFIRM_PHRASE },
  }), false);
  assert.equal(Sim.unwrapOption({ boolean: true }), true);
  assert.equal(Sim.unwrapOption({ string: 'CREATE_LOCAL_SIM' }), 'CREATE_LOCAL_SIM');
});

test('onTick reads NF scheduled-hook options from ctx.config', async () => {
  const state = { existing: [] };
  const http = mockHttp(state);
  const disabled = await onTick({ http, config: { enableSimulator: false } });
  assert.equal(disabled.skipped, 'disabled');
  assert.equal(state.posts.length, 0);
  const result = await onTick({
    http,
    config: {
      enableSimulator: { boolean: true },
      simulatorConfirm: { string: Sim.CONFIRM_PHRASE },
    },
  });
  assert.equal(result.ok, true);
  assert.ok(result.created > 0);
  assert.equal(state.posts.length, result.created);
});

test('planSync allocates free instances from 8000 and never reuses a foreign name', () => {
  const cat = Sim.catalog();
  const first = cat.points[0];
  const planned = Sim.planSync(listing([
    { instance: 1, name: 'open-meteo-temp' },
    { instance: 8000, name: 'someone-elses-av' },
    { instance: 8010, name: first.name },
  ]), cat);
  assert.ok(planned.create.every((c) => c.instance !== 1 && c.instance !== 8000));
  assert.ok(planned.create.every((c) => !Object.prototype.hasOwnProperty.call(Sim.createBody(c, 0), 'uuid')));
  const owned = planned.patch.find((p) => p.name === first.name);
  assert.equal(owned.instance, 8010);
  assert.ok(planned.create[0].instance >= 8001);
});

test('createBody and patchBody never include a uuid', () => {
  const body = Sim.createBody({ name: 'nfft-sim.x', objectType: 'OBJECT_ANALOG_VALUE', instance: 8001, dis: 'x' }, 12.3);
  assert.deepEqual(Object.keys(body), ['objectId', 'props']);
  assert.equal(body.objectId.instance, 8001);
  assert.equal(JSON.stringify(body).includes('uuid'), false);
  const bin = Sim.createBody({ name: 'nfft-sim.y', objectType: 'OBJECT_BINARY_VALUE', instance: 8002, dis: 'y' }, true);
  assert.equal(bin.props.some((p) => p.property === 'PROP_PRESENT_VALUE' && p.value.enumerated === 1), true);
  const patch = Sim.patchBody({ objectType: 'OBJECT_ANALOG_VALUE', instance: 8001 }, 4);
  assert.equal(JSON.stringify(patch).includes('uuid'), false);
  assert.throws(() => Sim.assertNoUuid({ url: '/api/v1/bacnet/local', body: { uuid: 'nope' } }));
});

test('createBody includes PROP_UNITS on analog values and omits it on binary values', () => {
  assert.equal(Sim.bacnetUnits('%'), 98);
  assert.equal(Sim.bacnetUnits('°C'), 62);
  assert.equal(Sim.bacnetUnits('Pa'), 53);
  assert.equal(Sim.bacnetUnits('L/s'), 87);
  assert.equal(Sim.bacnetUnits(''), 95);
  const cases = [
    ['%', 98],
    ['°C', 62],
    ['Pa', 53],
    ['L/s', 87],
    ['', 95],
  ];
  for (const [unit, enumerated] of cases) {
    const body = Sim.createBody({
      name: 'nfft-sim.u',
      objectType: 'OBJECT_ANALOG_VALUE',
      instance: 8001,
      dis: 'u',
      unit,
    }, 1);
    const units = body.props.find((p) => p.property === 'PROP_UNITS');
    assert.ok(units, `missing PROP_UNITS for ${unit || '(none)'}`);
    assert.equal(units.value.enumerated, enumerated);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'uuid'), false);
  }
  const bin = Sim.createBody({
    name: 'nfft-sim.b',
    objectType: 'OBJECT_BINARY_VALUE',
    instance: 8002,
    dis: 'b',
  }, true);
  assert.equal(bin.props.some((p) => p.property === 'PROP_UNITS'), false);
});

test('physics starves VAV-03 and stops flow when the fan is off', () => {
  const values = Sim.initialValues(Sim.catalog());
  assert.ok(values['vav-01.flow'] > 0);
  assert.ok(values['vav-03.flow'] < values['vav-01.flow']);
  assert.ok(values['ahu-1.dsp'] > 0);
  const off = Sim.stepPhysics({ ...values, 'ahu-1.sf-cmd': 0, 'ahu-1.sf-status': 0, 'ahu-1.sf-speed': 0 });
  assert.equal(off['vav-01.flow'], 0);
  assert.equal(off['ahu-1.dsp'], 0);
});

test('run is a no-op when the simulator is not armed', async () => {
  const state = {};
  const http = mockHttp(state);
  const result = await Sim.run({ options: { enableSimulator: false }, http });
  assert.equal(result.skipped, 'disabled');
  assert.deepEqual(state.gets, []);
  assert.deepEqual(state.posts, []);
  const tick = await onTick({ options: {}, http });
  assert.equal(tick.skipped, 'disabled');
});

test('run creates new local objects without uuids and skips a missing BACnet server', async () => {
  const armed = { enableSimulator: true, simulatorConfirm: Sim.CONFIRM_PHRASE };
  const missing = {};
  const none = mockHttp(missing);
  missing.configOk = false;
  const skipped = await Sim.run({ options: armed, http: none });
  assert.equal(skipped.skipped, 'no_bacnet_server');
  assert.deepEqual(missing.posts, []);

  const state = { existing: [{ instance: 1, name: 'open-meteo-temp' }] };
  const http = mockHttp(state);
  const first = await Sim.run({ options: armed, http }, { createLimit: 5, skipTags: true });
  assert.equal(first.created, 5);
  assert.equal(first.pending_creates > 0, true);
  assert.equal(state.posts.length, 5);
  assert.ok(state.posts.every((b) => !Object.prototype.hasOwnProperty.call(b, 'uuid')));
  assert.ok(state.posts.every((b) => b.objectId.instance >= 8000 && b.objectId.instance !== 1));
  assert.ok(state.posts.every((b) => b.objectId.objectType !== 'OBJECT_ANALOG_VALUE'
    || b.props.some((p) => p.property === 'PROP_UNITS' && Number.isFinite(p.value.enumerated))));
  assert.ok(state.posts.every((b) => b.objectId.objectType !== 'OBJECT_BINARY_VALUE'
    || !b.props.some((p) => p.property === 'PROP_UNITS')));
  assert.equal(state.patches.length, 0);
  // Second tick against an updated listing patches only our names.
  state.local = listing([
    { instance: 1, name: 'open-meteo-temp' },
    ...state.posts.map((b) => ({
      instance: b.objectId.instance,
      name: b.props.find((p) => p.property === 'PROP_OBJECT_NAME').value.characterString,
      objectType: b.objectId.objectType,
    })),
  ]);
  state.posts = [];
  const cat = Sim.catalog();
  // Pretend every catalog point already exists under our prefix so the next tick only patches.
  state.local = listing(cat.points.map((p, i) => ({ instance: 8100 + i, name: p.name, objectType: p.objectType })));
  const second = await Sim.run({ options: armed, http }, { skipTags: false });
  assert.equal(second.created, 0);
  assert.ok(second.patched > 0);
  assert.equal(state.posts.filter((b) => b.objectId).length, 0);
  assert.ok(state.upserts.length >= 1);
  assert.ok(state.upserts.length >= 1);
  const tagged = state.upserts[0].points;
  assert.ok(tagged.every((pt) => Sim.isUuid(pt.uuid)));
  assert.ok(tagged.filter((pt) => pt.pointType !== 'SITE' && pt.pointType !== 'EQUIPMENT').every((pt) => String(pt.name).startsWith('nfft-sim.')));

});

test('tagPayload sets SITE/EQUIPMENT pointTypes, feed relationships, and uuids only for nfft-sim names', () => {
  const cat = Sim.catalog();
  const vav = cat.equipment.find((e) => e.id === 'nfft-sim-vav-01');
  assert.ok(vav && vav.airRef === 'nfft-sim-ahu-1');
  const first = cat.points[0];
  const listing = listingWith([
    { instance: 1, name: 'WEB OA-T', uuid: 'weather-uuid' },
    { instance: 8000, name: first.name, uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  ]);
  const planned = Sim.planSync(listing, cat);
  const tags = Sim.tagPayload(cat, listing, planned, []);
  const site = tags.find((t) => t.pointType === 'SITE');
  assert.equal(site.attrs.id, 'nfft-sim-site');
  assert.equal(site.layer, 'model');
  assert.equal(site.uuid, Sim.stableUuid('site:nfft-sim-site'));
  assert.equal(site.uuid, 'baee4790-9a46-5235-94e5-a590e91ae2b7');
  const equip = tags.find((t) => t.pointType === 'EQUIPMENT' && t.attrs.id === 'nfft-sim-vav-01');
  assert.equal(equip.attrs.airRef, 'nfft-sim-ahu-1');
  const pt = tags.find((t) => t.name === first.name);
  assert.equal(pt.uuid, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.ok(tags.every((t) => Sim.isUuid(t.uuid)));
  assert.ok(tags.every((t) => t.uuid !== 'weather-uuid'));
  assert.ok(tags.filter((t) => t.layer !== 'model').every((t) => String(t.name).startsWith('nfft-sim.')));
});

function listingWith(objects) {
  return {
    objects: objects.map((o) => ({
      objectId: { objectType: o.objectType || 'OBJECT_ANALOG_VALUE', instance: o.instance },
      uuid: o.uuid,
      props: [{ property: 'PROP_OBJECT_NAME', value: { characterString: o.name } }],
    })),
  };
}

test('sliceRotate pages through a list across minutes', () => {
  const all = [0, 1, 2, 3, 4];
  assert.deepEqual(Sim.sliceRotate(all, 10, 0), all);
  const a = Sim.sliceRotate(all, 2, 0);
  const b = Sim.sliceRotate(all, 2, 60000);
  assert.equal(a.length, 2);
  assert.notDeepEqual(a, b);
});

test('stableUuid is deterministic RFC 4122 v5 and rejects invalid owned uuids', () => {
  assert.equal(Sim.isUuid('sim-uuid-1'), false);
  assert.equal(Sim.isUuid('baee4790-9a46-5235-94e5-a590e91ae2b7'), true);
  assert.equal(Sim.stableUuid('site:nfft-sim-site'), 'baee4790-9a46-5235-94e5-a590e91ae2b7');
  assert.equal(Sim.ownedUuid(listingWith([{ instance: 8000, name: 'nfft-sim.ahu-1.oa-dmp-cmd', uuid: 'not-a-uuid' }]), 'nfft-sim.ahu-1.oa-dmp-cmd'), undefined);
});

test('tagPayload puts every point row in the model layer, next to the SITE and EQUIPMENT rows', () => {
  const cat = Sim.catalog();
  const existing = listing(cat.points.map((p, i) => ({ instance: 8100 + i, name: p.name, objectType: p.objectType })));
  const planned = Sim.planSync(existing, cat);
  const tags = Sim.tagPayload(cat, existing, planned, []);
  const rows = tags.filter((t) => !Sim.isModelRecord(t));
  assert.ok(rows.length > 100);
  assert.ok(rows.every((t) => t.layer === 'model'), 'a point row without layer=model is accepted by NF and tags nothing');
  assert.ok(tags.filter(Sim.isModelRecord).every((t) => t.layer === 'model'));
  assert.equal(tags.filter((t) => t.pointType === 'SITE').length, 1);
});

test('tagBatchSize catches up while model records are missing and settles once they all exist', async () => {
  const expected = 100;
  const at = (modelCount) => ({ post: async () => ({ data: { totalCount: String(modelCount) }, status: 200 }) });
  assert.equal(await Sim.tagBatchSize(at(17), expected), Sim.TAG_POINT_BATCH_CATCHUP);
  assert.equal(await Sim.tagBatchSize(at(99), expected), Sim.TAG_POINT_BATCH_CATCHUP);
  assert.equal(await Sim.tagBatchSize(at(100), expected), Sim.TAG_POINT_BATCH);
  assert.equal(await Sim.tagBatchSize(at(150), expected), Sim.TAG_POINT_BATCH);
  assert.equal(await Sim.tagBatchSize({ post: async () => { throw new Error('boom'); } }, expected), Sim.TAG_POINT_BATCH);
  assert.equal(await Sim.tagBatchSize({ post: async () => ({ data: {}, status: 200 }) }, expected), Sim.TAG_POINT_BATCH);
  assert.ok(Sim.TAG_POINT_BATCH_CATCHUP > Sim.TAG_POINT_BATCH);
});

test('run tags catch-up batches while the model layer is incomplete, then the steady batch', async () => {
  const armed = { enableSimulator: true, simulatorConfirm: Sim.CONFIRM_PHRASE };
  const cat = Sim.catalog();
  const expected = 1 + cat.equipment.length + cat.points.length;
  const state = { modelCount: 17 };
  const http = mockHttp(state);
  state.local = listing(cat.points.map((p, i) => ({ instance: 8100 + i, name: p.name, objectType: p.objectType })));
  await Sim.run({ options: armed, http }, { now: 0 });
  const rowsOf = (u) => u.points.filter((r) => r.pointType !== 'SITE' && r.pointType !== 'EQUIPMENT');
  assert.equal(state.queries[0].layer, 'model');
  assert.equal(rowsOf(state.upserts[0]).length, Sim.TAG_POINT_BATCH_CATCHUP);
  assert.ok(rowsOf(state.upserts[0]).every((r) => r.layer === 'model'));
  state.modelCount = expected;
  await Sim.run({ options: armed, http }, { now: 120000 });
  assert.equal(rowsOf(state.upserts[1]).length, Sim.TAG_POINT_BATCH);
  await Sim.run({ options: armed, http }, { now: 240000, tagLimit: 3 });
  assert.equal(rowsOf(state.upserts[2]).length, 3, 'ctx.tagLimit still wins');
});
