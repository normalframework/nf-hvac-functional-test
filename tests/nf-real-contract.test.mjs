// Contract tests: the fake NF (tests/fixtures/fake/server.js) and NfClient against responses RECORDED from a real
// Normal Framework 3.10.11 (tests/fixtures/nf-real/*.json, see its README). Each recording is
// {id, request, response:{status, contentType, body}}. CI keeps checking the fake against real NF behaviour
// with no live NF around.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFake, MOCK_ONLY_ROUTES, REMOVED_ROUTES } = require('./fixtures/fake/server');
const { VirtualClock } = require('./fixtures/fake/clock');
const { NfClient, NfError, errorText } = require('../hooks/lib/nf/client');
const { shapeProblems } = require('./fixtures/nf-shape');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nf-real');
const fx = (id) => JSON.parse(fs.readFileSync(path.join(FIX, `${id}.json`), 'utf8'));
const LAYER = 'hpl:bacnet:1';
const ZERO = '00000000-0000-0000-0000-000000000000';
const SIM = '00000000-0000-4000-8000-0000000000a1';

async function withFake(fn, options = {}) {
  const fake = await createFake({ clock: new VirtualClock(Date.parse('2026-01-01T00:00:00Z')), ...options });
  const client = new NfClient({ baseUrl: fake.baseUrl, sleep: async () => {} });
  try {
    await fn({ fake, client });
  } finally {
    await fake.close();
  }
}

/** Raw HTTP, so status, content type and an empty body can be compared. */
async function send(fake, method, requestPath, body) {
  const response = await fetch(fake.baseUrl + requestPath, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const type = (response.headers.get('content-type') || '').split(';')[0];
  return { status: response.status, type, text, json: type === 'application/json' ? JSON.parse(text) : null };
}

/** Assert the status and content type of recording `id`, and an empty body when real NF sends none. */
function expectEmptyFailure(got, id) {
  const recorded = fx(id).response;
  assert.equal(got.status, recorded.status, `${id}: status`);
  assert.equal(got.type, recorded.contentType, `${id}: content type`);
  assert.equal(got.text, '', `${id}: body is empty`);
}

test('recordings are well formed and generic', () => {
  const files = fs.readdirSync(FIX).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 80, `expected the full recording set, found ${files.length}`);
  for (const name of files) {
    const text = fs.readFileSync(path.join(FIX, name), 'utf8');
    const recording = JSON.parse(text);
    assert.equal(recording.id, name.replace(/\.json$/, ''), `${name}: id matches the file name`);
    assert.ok(recording.request && recording.request.method && recording.request.path, `${name}: request`);
    assert.ok(recording.response && Number.isInteger(recording.response.status) && 'body' in recording.response, `${name}: response`);
    for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []) {
      assert.ok(ip === '127.0.0.1' || ip.startsWith('192.0.2.'), `${name}: only loopback and documentation addresses, found ${ip}`);
    }
    assert.ok(!/NF_CLIENT_SECRET|client_secret|password|token":\s*"[^"]/i.test(text.replace(/"nextPageToken":\s*""/g, '')), `${name}: no credentials`);
  }
});

test('commands: start, list, extend, cancel use camelCase, string ids and empty-body errors', async () => {
  await withFake(async ({ fake }) => {
    const started = await send(fake, 'POST', '/api/v2/command', { name: 'contract-probe', duration: '120s' });
    assert.equal(started.status, 200);
    assert.deepEqual(shapeProblems(started.json, fx('commands__start').response.body), []);
    assert.equal(typeof started.json.id, 'string');

    const listed = await send(fake, 'GET', '/api/v2/command');
    assert.deepEqual(shapeProblems(listed.json, fx('commands__list_one').response.body, { optional: [] }), []);
    assert.equal(listed.json.totalCount, '1');

    const extended = await send(fake, 'POST', `/api/v2/command/${started.json.id}`, { new_expiration: new Date(fake.clock.now() + 600000).toISOString() });
    assert.deepEqual(extended.json, fx('commands__extend').response.body);

    expectEmptyFailure(await send(fake, 'POST', '/api/v2/command', { name: 'contract-probe', duration: '300s' }), 'commands__start_duplicate_name');
    expectEmptyFailure(await send(fake, 'POST', '/api/v2/command', { name: 'x', bogus: 1, duration: '1m' }), 'commands__start_unknown_field');
    expectEmptyFailure(await send(fake, 'POST', '/api/v2/command', { name: 'long', duration: '48h' }), 'commands__start_48h');

    const cancelled = await send(fake, 'DELETE', `/api/v2/command/${started.json.id}`);
    assert.deepEqual(cancelled.json, fx('commands__cancel').response.body);
    expectEmptyFailure(await send(fake, 'DELETE', `/api/v2/command/${started.json.id}`), 'commands__cancel_again');
    const empty = await send(fake, 'GET', '/api/v2/command');
    assert.deepEqual(shapeProblems(empty.json, fx('commands__list_empty').response.body), []);
    const zombies = await send(fake, 'GET', '/api/v2/command/zombies');
    assert.deepEqual(shapeProblems(zombies.json, fx('commands__zombies').response.body), []);
  });
});

test('commands: in-band errors have a message and no code; an unknown point is an empty 400', async () => {
  await withFake(async ({ fake, client }) => {
    fake.seedAhu({ points: { cooling_valve_position_command: SIM } });
    const started = await client.startCommand({ name: 'contract-probe', duration: '120s' });
    const reply = await client.writeInCommand({
      command_id: started.id,
      writes: [{ point: { uuid: SIM, layer: LAYER }, priority: 1, value: { real: 0 } }],
    });
    const recorded = fx('commands__write_pending_backoff').response.body;
    assert.deepEqual(shapeProblems(reply.errors, recorded.errors), []);
    assert.equal('code' in reply.errors[0].error, false, 'real NF carries no error code');
    assert.match(errorText(reply.errors[0].error), /priority_rejected/);

    const unknown = await send(fake, 'POST', '/api/v2/command/read', fx('commands__read_unknown_point').request.body);
    expectEmptyFailure(unknown, 'commands__read_unknown_point');
  });
});

test('errorText reads the recorded in-band error', () => {
  const { errors } = fx('commands__read_layer_without_driver').response.body;
  assert.equal(errorText(errors[0].error), 'layer has no hpl driver');
  assert.equal(errorText({ code: 'guardrail', message: 'm' }), 'guardrail');
  assert.equal(errorText(undefined), 'unknown');
});

test('platform/env: every variable, identified by id, the name filter ignored', async () => {
  await withFake(async ({ fake, client }) => {
    const filtered = await send(fake, 'GET', '/api/v1/platform/env?name=BACNET_PRIORITY');
    const plain = await send(fake, 'GET', '/api/v1/platform/env');
    assert.deepEqual(filtered.json, plain.json);
    assert.deepEqual(shapeProblems(plain.json, fx('platform__env').response.body, {}), []);
    const entry = plain.json.variables.find((item) => item.id === 'BACNET_PRIORITY');
    assert.equal(entry.integer, '8');
    assert.ok(plain.json.variables.length > 1, 'other variables come back too');
    assert.equal(await client.readCommandPriority(), 8);
  });
  await withFake(async ({ client }) => {
    assert.equal(await client.readCommandPriority(), null, 'no BACNET_PRIORITY variable means unknown');
  }, { commandPriority: null });
});

test('readCommandPriority reads the recorded platform/env reply (id, not display name)', async () => {
  const recorded = fx('platform__env').response;
  const fetchImpl = async () => new Response(JSON.stringify(recorded.body), { status: 200, headers: { 'content-type': recorded.contentType } });
  const client = new NfClient({ baseUrl: 'http://nf.invalid', fetch: fetchImpl, sleep: async () => {} });
  const wanted = recorded.body.variables.find((item) => item.id === 'BACNET_PRIORITY');
  assert.equal(await client.readCommandPriority(), Number(wanted.integer));
});

test('client refuses an HTML 200 (an unknown route) and tolerates empty failure bodies', async () => {
  await withFake(async ({ fake, client }) => {
    const shell = await send(fake, 'GET', '/api/v1/nope');
    assert.equal(shell.status, fx('errors__unknown_get_route_spa_fallback').response.status);
    assert.equal(shell.type, 'text/html');
    await assert.rejects(() => client.request('/api/v1/nope', { method: 'GET' }), (error) => error instanceof NfError && /not an NF API reply/.test(error.message));
    await assert.rejects(() => client.cancelCommand(99), (error) => error instanceof NfError && error.status === 404);
    const post = await send(fake, 'POST', '/api/v1/nope', {});
    assert.equal(post.status, 405);
    assert.equal(post.type, 'text/html');
  });
});

test('point/query: paging, filters, unknown layer and field handling match NF', async () => {
  await withFake(async ({ fake, client }) => {
    fake.seedAhu({ points: { cooling_valve_position_command: SIM, supply_air_temperature: '00000000-0000-4000-8000-0000000000a2' } });
    const total = [...fake.points.values()].filter((point) => point.layer === LAYER).length;
    assert.ok(total >= 1);
    const withPage = await send(fake, 'POST', '/api/v1/point/query', { layer: LAYER, pageSize: 1 });
    assert.deepEqual(shapeProblems(withPage.json, fx('point_query__model_layer_page_a').response.body, { subset: true, ignore: ['points'] }), []);
    assert.equal(withPage.json.points.length, 1);
    assert.equal(withPage.json.totalCount, String(total));
    assert.equal(withPage.json.nextPageToken, '');
    assert.deepEqual(shapeProblems(withPage.json.points[0], fx('point_query__bacnet_backed_point_driver_layer').response.body.points[0], { subset: true, free: ['attrs', 'args', 'stats', 'hplDriver'] }), []);

    const noSize = await send(fake, 'POST', '/api/v1/point/query', { layer: LAYER });
    assert.equal(noSize.json.points.length, fx('point_query__no_page_size').response.body.points.length);
    assert.equal(noSize.json.totalCount, String(total));

    const snake = await send(fake, 'POST', '/api/v1/point/query', { layer: LAYER, page_size: 1, page_offset: total - 1 });
    assert.equal(snake.json.points.length, 1);

    // uuid, uuids and equipRef are not NF filters: they are ignored, not applied.
    const ignored = await send(fake, 'POST', '/api/v1/point/query', { layer: LAYER, pageSize: 10, uuid: ZERO, uuids: [ZERO], equipRef: 'x' });
    assert.equal(ignored.json.points.length, total);

    expectEmptyFailure(await send(fake, 'POST', '/api/v1/point/query', fx('errors__query_unknown_layer').request.body), 'errors__query_unknown_layer');
    expectEmptyFailure(await send(fake, 'POST', '/api/v1/point/query', fx('errors__query_negative_page_size').request.body), 'errors__query_negative_page_size');
    expectEmptyFailure(await send(fake, 'POST', '/api/v1/point/query', '{'), 'errors__query_bad_json');

    // Client: equip_ref becomes structuredQuery.field, markers match on attrs.markers, and a page size is always sent.
    await client.upsertPoints([
      { uuid: '00000000-0000-4000-8000-0000000000b1', layer: LAYER, attrs: { equipRef: 'ahu_a', markers: 'point,his,outside,air' } },
      { uuid: '00000000-0000-4000-8000-0000000000b2', layer: LAYER, attrs: { equipRef: 'ahu_a', markers: 'point,his,supply,air' } },
      { uuid: '00000000-0000-4000-8000-0000000000b3', layer: LAYER, attrs: { equipRef: 'ahu_b', markers: 'point,his,outside,air' } },
    ]);
    const byEquip = await client.queryPoints({ equip_ref: 'ahu_a', layer: LAYER });
    assert.deepEqual(byEquip.points.map((point) => point.uuid).sort(), ['00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2']);
    const byMarkers = await client.queryPoints({ equip_ref: 'ahu_a', markers: ['outside', 'air'], layer: LAYER });
    assert.deepEqual(byMarkers.points.map((point) => point.uuid), ['00000000-0000-4000-8000-0000000000b1']);
  });
});

test('point/points: results shape, no-layer writes apply nothing, attrs merge', async () => {
  await withFake(async ({ fake }) => {
    const created = await send(fake, 'POST', '/api/v1/point/points', { points: [{ uuid: SIM, layer: LAYER, attrs: { a: '1' } }] });
    assert.deepEqual(shapeProblems(created.json, fx('point_points__post_model_layer').response.body), []);
    const noLayer = await send(fake, 'POST', '/api/v1/point/points', { points: [{ uuid: SIM, attrs: { b: '2' } }] });
    assert.equal(noLayer.json.results[0].success, true);
    assert.deepEqual(fake.points.get(SIM).attrs, { a: '1' }, 'a write without a base layer applied nothing');
    await send(fake, 'POST', '/api/v1/point/points', { points: [{ uuid: SIM, layer: LAYER, attrs: { b: '2' } }] });
    assert.deepEqual(fake.points.get(SIM).attrs, { a: '1', b: '2' }, 'attrs merge');
  });
});

test('points/data: the real history route, and its failures', async () => {
  await withFake(async ({ fake, client }) => {
    const ok = await send(fake, 'POST', '/api/v1/points/data', fx('points_data__post_ok').request.body);
    assert.deepEqual(shapeProblems(ok.json, fx('points_data__post_ok').response.body), []);
    expectEmptyFailure(await send(fake, 'POST', '/api/v1/points/data', fx('points_data__post_malformed_uuid').request.body), 'points_data__post_malformed_uuid');
    expectEmptyFailure(await send(fake, 'POST', '/api/v1/points/data', fx('points_data__post_missing_uuid').request.body), 'points_data__post_missing_uuid');
    const reply = await client.addData({ batches: [{ uuid: ZERO, values: [{ ts: '2026-01-01T00:00:00Z', value: 3 }] }] });
    assert.deepEqual(shapeProblems(reply, fx('points_data__post_ok').response.body), []);
  });
});

test('addData sends the NF wire body: points, values, real', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response('{"success":true,"taskUuid":""}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new NfClient({ baseUrl: 'http://nf.invalid', fetch: fetchImpl, sleep: async () => {} });
  await client.addData({ batches: [{ uuid: ZERO, values: [{ ts: '2026-01-01T00:00:00Z', value: 3 }] }] });
  assert.equal(seen[0].url, 'http://nf.invalid/api/v1/points/data');
  assert.deepEqual(JSON.parse(seen[0].init.body), { points: [{ uuid: ZERO, values: [{ ts: '2026-01-01T00:00:00Z', real: 3 }] }] });
});

test('routes real NF answers 405 are 405 in the fake too, and the mock-only list is what is left', async () => {
  const recordedAbsent = {
    'POST /api/v2/bacnet/read': 'routes__v2_bacnet_read',
    'POST /api/v2/bacnet/write': 'routes__v2_bacnet_write_post',
    'POST /api/v1/point/upsert': 'routes__v1_point_upsert_post',
    'POST /api/v1/data': 'routes__v1_data_post',
  };
  assert.deepEqual([...REMOVED_ROUTES].sort(), Object.keys(recordedAbsent).sort());
  await withFake(async ({ fake }) => {
    for (const route of REMOVED_ROUTES) {
      const recording = fx(recordedAbsent[route]);
      assert.equal(recording.response.status, 405, `${route} is not an NF route`);
      const [method, routePath] = route.split(' ');
      const got = await send(fake, method, routePath, {});
      assert.deepEqual([got.status, got.type], [405, 'text/html'], route);
    }
  });
  assert.deepEqual([...MOCK_ONLY_ROUTES], ['POST /api/v2/command/clear']);
});

test('point lookup by uuid is structuredQuery.field uuid, in the fake and in the client', async () => {
  await withFake(async ({ fake, client }) => {
    fake.seedAhu({ points: { cooling_valve_position_command: SIM, supply_air_temperature: '00000000-0000-4000-8000-0000000000a2' } });
    const request = fx('point_query__by_uuid_driver_layer').request.body;
    const got = await send(fake, 'POST', '/api/v1/point/query', { ...request, layer: LAYER, structuredQuery: { field: { property: 'uuid', text: SIM } } });
    assert.equal(got.json.totalCount, '1');
    assert.equal(got.json.points[0].uuid, SIM);
    assert.deepEqual(shapeProblems(got.json, fx('point_query__by_uuid_driver_layer').response.body, { subset: true, ignore: ['points'] }), []);
    const none = await send(fake, 'POST', '/api/v1/point/query', { layer: 'default', pageSize: 5, structuredQuery: { field: { property: 'uuid', text: ZERO } } });
    assert.deepEqual(none.json, fx('point_query__by_uuid_unknown').response.body);
    const viaClient = await client.queryPoints({ uuid: SIM, layer: LAYER });
    assert.deepEqual(viaClient.points.map((point) => point.uuid), [SIM]);
  });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response('{"points":[],"totalCount":"0","nextPageToken":""}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new NfClient({ baseUrl: 'http://nf.invalid', fetch: fetchImpl, sleep: async () => {} });
  await client.queryPoints({ uuid: SIM, layer: 'default' });
  assert.deepEqual(seen[0], { layer: 'default', pageSize: 500, structuredQuery: { field: { property: 'uuid', text: SIM } } });
});

test('bacnet/readproperty: the fake answers like NF, by device address, with in-band errors', async () => {
  await withFake(async ({ fake }) => {
    fake.seedAhu({ points: { cooling_valve_position_command: SIM, supply_air_temperature: '00000000-0000-4000-8000-0000000000a2' } });
    const listed = await send(fake, 'POST', '/api/v1/point/query', { layer: LAYER, pageSize: 10 });
    const valve = listed.json.points.find((point) => point.uuid === SIM);
    const device = valve.hpldata.deviceAddress;
    const query = (type, instance, property, extra = '') => `/api/v1/bacnet/readproperty?object_id.object_type=${type}&object_id.instance=${instance}&property_id=${property}&array_index=4294967295&device_address.mac=${encodeURIComponent(device.mac)}&device_address.port_id=${device.portId}${extra}`;
    const object = valve.hpldata.property.objectId;

    const present = await send(fake, 'GET', query(object.objectType, object.instance, 'PROP_PRESENT_VALUE'));
    assert.equal(present.status, 200);
    assert.deepEqual(shapeProblems(present.json, fx('bacnet__readproperty_present_value').response.body), []);

    const array = await send(fake, 'GET', query(object.objectType, object.instance, 'PROP_PRIORITY_ARRAY'));
    assert.equal(array.json.value.array.length, 16);

    const unknownProperty = await send(fake, 'GET', query('OBJECT_ANALOG_INPUT', 1, 'PROP_PRIORITY_ARRAY'));
    assert.deepEqual(shapeProblems(unknownProperty.json, fx('bacnet__readproperty_unknown_property_in_band_error').response.body), []);
    assert.equal(unknownProperty.status, 200);
    const unknownObject = await send(fake, 'GET', query('OBJECT_ANALOG_VALUE', 99999, 'PROP_PRESENT_VALUE'));
    assert.deepEqual(shapeProblems(unknownObject.json, fx('bacnet__readproperty_unknown_object_in_band_error').response.body), []);

    const byDeviceId = await send(fake, 'GET', `/api/v1/bacnet/readproperty?object_id.object_type=${object.objectType}&object_id.instance=${object.instance}&property_id=PROP_PRESENT_VALUE&device_address.device_id=1`);
    expectEmptyFailure(byDeviceId, 'bacnet__readproperty_by_device_id_500');
    const badName = await send(fake, 'GET', query(object.objectType, object.instance, 'PROP_NOPE_NOT_A_THING').replace('PROP_NOPE_NOT_A_THING', 'nope'));
    expectEmptyFailure(badName, 'bacnet__readproperty_bad_property_name');
  });
});

test('readPriorityArray: finds the address in hpldata, reads PROP_PRIORITY_ARRAY, and is null when it cannot', async () => {
  await withFake(async ({ fake, client }) => {
    fake.seedAhu({ points: { cooling_valve_position_command: SIM, supply_air_temperature: '00000000-0000-4000-8000-0000000000a2' } });
    fake.writeSlot(SIM, 8, 25);
    const slots = await client.readPriorityArray({ uuid: SIM });
    assert.equal(slots.length, 16);
    assert.equal(slots[7], 25);
    assert.equal(slots[0], null);
    assert.equal(await client.readPriorityArray({ uuid: '00000000-0000-4000-8000-0000000000a2' }), null, 'no priority array on an input');
    assert.equal(await client.readPriorityArray({ uuid: ZERO }), null, 'unknown point');
    fake.points.get(SIM).offline = true;
    assert.equal(await client.readPriorityArray({ uuid: SIM }), null, 'in-band BACnet failure');
  });
  // A point with no routable address (the recorded local object has an empty mac and port 0): no read is attempted.
  const local = fx('point_query__bacnet_backed_point_driver_layer').response.body;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(local), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new NfClient({ baseUrl: 'http://nf.invalid', fetch: fetchImpl, sleep: async () => {} });
  assert.equal(await client.readPriorityArray({ uuid: local.points[0].uuid }), null);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/v1\/point\/query$/);
});

test('readBacnetProperty builds the recorded readproperty request', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: new URL(String(url)), method: init.method });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new NfClient({ baseUrl: 'http://nf.invalid', fetch: fetchImpl, sleep: async () => {} });
  await client.readBacnetProperty({ mac: 'wAACCrrA', portId: 1, objectType: 'OBJECT_ANALOG_OUTPUT', instance: 7 }, 'PROP_PRIORITY_ARRAY');
  const recorded = new URL(`http://x${fx('bacnet__readproperty_present_value').request.path}`);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url.pathname, recorded.pathname);
  assert.deepEqual([...seen[0].url.searchParams.keys()].sort(), [...recorded.searchParams.keys()].sort());
  assert.equal(seen[0].url.searchParams.get('device_address.mac'), 'wAACCrrA');
  assert.equal(seen[0].url.searchParams.get('array_index'), '4294967295');
});

test('real NF has a bacnet/writeproperty route; it is recorded as existing and deliberately not used', () => {
  assert.equal(fx('routes__bacnet_writeproperty_empty_body').response.status, 400);
  assert.match(fx('routes__bacnet_writeproperty_empty_body').note, /NOT verified/);
});

// ---- Priority arrays and command writes, recorded from a real NF reading a bench BACnet controller ----

const { unwrapSlot, slotMatches, parsePriorityArray } = require('../hooks/lib/writers/verify');
const { DeviceObject } = require('./fixtures/fake/device');

const BACNET_POINT = {
  points: [{
    uuid: SIM,
    hpldata: {
      deviceAddress: { mac: 'wAACCrrA', net: 2, adr: 'Bw==', portId: 1 },
      property: { objectId: { objectType: 'OBJECT_ANALOG_OUTPUT', instance: 8101 } },
      hasPriorityArray: true,
    },
  }],
};

/** NfClient whose point lookup answers a BACnet point and whose readproperty answers `replyBody` (or a status). */
function clientAnswering(replyBody, status = 200) {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/v1/point/query')) {
      return new Response(JSON.stringify(BACNET_POINT), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(replyBody), { status, headers: { 'content-type': 'application/json' } });
  };
  return new NfClient({ baseUrl: 'http://nf.invalid', fetch: fetchImpl, sleep: async () => {} });
}

test('the client parses recorded priority arrays: empty, held by another writer, and our command slot', async () => {
  const empty = await clientAnswering(fx('bacnet__readproperty_priority_array_empty').response.body).readPriorityArray({ uuid: SIM });
  assert.deepEqual(empty, Array(16).fill(null));

  const held = await clientAnswering(fx('bacnet__readproperty_priority_array_held').response.body).readPriorityArray({ uuid: SIM });
  assert.equal(held[7], 12);
  assert.equal(held.filter((slot) => slot !== null).length, 1);

  const binary = await clientAnswering(fx('bacnet__readproperty_priority_array_binary_empty').response.body).readPriorityArray({ uuid: SIM });
  assert.deepEqual(binary, Array(16).fill(null));

  // The command was written with request priority 16 and NF filled slot 12, its BACNET_PRIORITY.
  const during = await clientAnswering(fx('bacnet__readproperty_priority_array_during_command').response.body).readPriorityArray({ uuid: SIM });
  assert.equal(during[11], 1);
  assert.equal(during[15], null, 'request priority 16 is ignored');
  assert.equal(during.filter((slot) => slot !== null).length, 1);

  const after = await clientAnswering(fx('bacnet__readproperty_priority_array_after_cancel').response.body).readPriorityArray({ uuid: SIM });
  assert.deepEqual(after, Array(16).fill(null), 'cancelling the command empties the slot');
});

test('slot encodings: null:true, real, enumerated; a boolean write matches a binary slot', () => {
  assert.equal(unwrapSlot({ null: true, array: [] }), null);
  assert.equal(unwrapSlot({ real: 12, array: [] }), 12);
  assert.equal(unwrapSlot({ enumerated: 1, array: [] }), 1);
  assert.equal(unwrapSlot({ nonsense: 1 }), undefined);
  assert.equal(parsePriorityArray(fx('bacnet__readproperty_priority_array_held').response.body.value.array)[7], 12);
  assert.equal(parsePriorityArray([{ nonsense: 1 }]), 'unreadable');
  assert.equal(slotMatches(1, true), true);
  assert.equal(slotMatches(0, false), true);
  assert.equal(slotMatches(0, true), false);
  assert.equal(slotMatches(12, 12), true);
  assert.equal(slotMatches(null, 0), false);
});

test('an in-band BACnet error on the priority array reads as unreadable', async () => {
  const body = fx('bacnet__readproperty_unknown_property_in_band_error').response.body;
  assert.equal(await clientAnswering(body).readPriorityArray({ uuid: SIM }), null);
});

test('the fake answers priority array, relinquish default and binary values in the recorded shape', async () => {
  await withFake(async ({ fake }) => {
    fake.seedAhu({ points: { cooling_valve_position_command: SIM } });
    const binaryId = '00000000-0000-4000-8000-0000000000b1';
    fake.points.set(binaryId, new DeviceObject({ uuid: binaryId, layer: LAYER, type: 'bo', relinquish: false }));
    const ask = async (uuid, property) => {
      const listed = await send(fake, 'POST', '/api/v1/point/query', { layer: LAYER, pageSize: 50 });
      const data = listed.json.points.find((point) => point.uuid === uuid).hpldata;
      const device = data.deviceAddress;
      const object = data.property.objectId;
      return send(fake, 'GET', `/api/v1/bacnet/readproperty?object_id.object_type=${object.objectType}&object_id.instance=${object.instance}&property_id=${property}&array_index=4294967295&device_address.mac=${encodeURIComponent(device.mac)}&device_address.port_id=${device.portId}`);
    };
    const emptyArray = await ask(SIM, 'PROP_PRIORITY_ARRAY');
    assert.deepEqual(shapeProblems(emptyArray.json, fx('bacnet__readproperty_priority_array_empty').response.body), []);
    fake.writeSlot(SIM, 8, 12);
    const held = await ask(SIM, 'PROP_PRIORITY_ARRAY');
    assert.deepEqual(shapeProblems(held.json, fx('bacnet__readproperty_priority_array_held').response.body), []);
    assert.deepEqual(held.json.value.array[7], { real: 12, array: [] });
    assert.deepEqual(held.json.value.array[0], { null: true, array: [] });

    const relinquish = await ask(SIM, 'PROP_RELINQUISH_DEFAULT');
    assert.deepEqual(shapeProblems(relinquish.json, fx('bacnet__readproperty_relinquish_default_analog').response.body), []);
    const binaryRelinquish = await ask(binaryId, 'PROP_RELINQUISH_DEFAULT');
    assert.deepEqual(shapeProblems(binaryRelinquish.json, fx('bacnet__readproperty_relinquish_default_binary').response.body), []);
    const binaryValue = await ask(binaryId, 'PROP_PRESENT_VALUE');
    assert.deepEqual(shapeProblems(binaryValue.json, fx('bacnet__readproperty_present_value_binary').response.body), []);
    const binaryArray = await ask(binaryId, 'PROP_PRIORITY_ARRAY');
    assert.deepEqual(shapeProblems(binaryArray.json, fx('bacnet__readproperty_priority_array_binary_empty').response.body), []);
  });
});

test('command write: the fake answers in the recorded shape and fills NF\'s BACNET_PRIORITY slot, not the requested one', async () => {
  await withFake(async ({ fake, client }) => {
    fake.seedAhu({ points: { cooling_valve_position_command: SIM } });
    const recorded = fx('commands__write_applied');
    const started = await client.startCommand({ name: 'contract-probe', duration: '60s' });
    const reply = await client.writeInCommand({
      command_id: started.id,
      cancel_on_conflict: true,
      writes: [{ point: { uuid: SIM, layer: 'default' }, priority: 16, value: { real: 1 } }],
    });
    assert.deepEqual(shapeProblems(reply, recorded.response.body), []);
    assert.equal(reply.writes[0].systemPriority, '0');
    assert.equal('priority' in reply.writes[0], false, 'real NF echoes no BACnet priority');

    const slots = await client.readPriorityArray({ uuid: SIM });
    assert.equal(slots[7], 1, 'the fake commandPriority is 8');
    assert.equal(slots[15], null);

    const listed = await send(fake, 'GET', '/api/v2/command');
    assert.deepEqual(shapeProblems(listed.json, fx('commands__list_with_active_write').response.body), []);

    await client.cancelCommand(started.id);
    assert.deepEqual(await client.readPriorityArray({ uuid: SIM }), Array(16).fill(null));
  });
  await withFake(async ({ fake, client }) => {
    fake.seedAhu({ points: { cooling_valve_position_command: SIM } });
    const started = await client.startCommand({ name: 'contract-probe', duration: '60s' });
    await client.writeInCommand({ command_id: started.id, writes: [{ point: { uuid: SIM, layer: 'default' }, priority: 16, value: { real: 1 } }] });
    const slots = await client.readPriorityArray({ uuid: SIM });
    assert.equal(slots[11], 1, 'a NF with BACNET_PRIORITY 12 fills slot 12');
  }, { commandPriority: 12 });
});
