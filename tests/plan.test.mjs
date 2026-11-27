import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadHaystackModel, loadRdfModel, mergeMaps, loadHaystackMap, evaluateWrite, confirmRuntime, RdfInputDisabledError } = require('../hooks/lib/model');
const { buildPlan } = require('../hooks/lib/plan');
const { uuid } = require('./fixtures/helpers');

const READS = {
  discharge_air_temperature: ['discharge', 'air', 'temp', 'sensor'],
  mixed_air_temperature: ['mixed', 'air', 'temp', 'sensor'],
  return_air_temperature: ['return', 'air', 'temp', 'sensor'],
  outdoor_air_intake_temperature: ['outside', 'air', 'temp', 'sensor'],
  discharge_air_static_pressure: ['discharge', 'air', 'pressure', 'sensor'],
  supply_fan_operating_status: ['fan', 'run', 'sensor'],
};

/**
 * @param {string} equipRef
 * @param {string[]} tags
 * @param {number} n
 * @param {boolean} writable
 */
function point(equipRef, tags, n, writable) {
  /** @type {Record<string, string>} */
  const attrs = { equipRef };
  for (const tag of tags) attrs[tag] = 'm:';
  if (writable) attrs.writable = 'm:';
  return { uuid: uuid(n), layer: 'hpl:bacnet:1', attrs };
}

/**
 * @param {{ damper?: boolean, freeze?: boolean, boxes: { id: string, kind: string }[] }} spec
 */
function fleet(spec) {
  /** @type {any[]} */
  const points = [];
  let n = 1;
  for (const tags of Object.values(READS)) {
    points.push(point('ahu_a', tags, n, false));
    n += 1;
  }
  points.push(point('ahu_a', ['cool', 'valve', 'cmd'], n, true));
  n += 1;
  points.push(point('ahu_a', ['heat', 'valve', 'cmd'], n, true));
  n += 1;
  if (spec.damper !== false) {
    points.push(point('ahu_a', ['outside', 'damper', 'cmd'], n, true));
    n += 1;
  }
  if (spec.freeze) {
    points.push(point('ahu_a', ['freezeStat', 'sensor'], n, false));
    n += 1;
  }
  /** @type {any[]} */
  const equipment = [
    { id: 'ahu_a', type: 'ahu', tags: ['ahu'] },
  ];
  for (const box of spec.boxes) {
    equipment.push({ id: box.id, type: 'vav', tags: ['vav'], ahuRef: 'ahu_a' });
    points.push(point(box.id, ['zone', 'air', 'temp', 'sensor'], n, false));
    n += 1;
    if (box.kind === 'flush') points.push(point(box.id, ['purge', 'cmd'], n, true));
    if (box.kind === 'setpoint') points.push(point(box.id, ['air', 'flow', 'sp'], n, true));
    if (box.kind === 'readonly') points.push(point(box.id, ['air', 'flow', 'sp'], n, false));
    if (box.kind === 'max_only') points.push(point(box.id, ['air', 'flow', 'max'], n, false));
    n += 1;
  }
  return loadHaystackModel({ equipment, points });
}

/**
 * @param {Record<string, any>} [extra]
 */
function policy(extra) {
  return {
    version: 1,
    plan: {
      ahu_strategy: 'per_point',
      steps: [
        { step_id: 'ahu.baseline', hold_minutes: 5 },
        { step_id: 'ahu.recirc', hold_minutes: 20 },
        { step_id: 'ahu.economizer', hold_minutes: 20 },
        { step_id: 'vav.max_cool', enabled: true, hold_minutes: 30 },
        { step_id: 'recovery', hold_minutes: 10 },
      ],
    },
    vav_test: { strategy: 'auto_per_box', min_capable_boxes: 1 },
    ...extra,
  };
}

/**
 * @param {any} plan
 * @param {string} stepId
 */
function step(plan, stepId) {
  const found = plan.steps.find((item) => item.step_id === stepId);
  if (!found) throw new Error(stepId);
  return found;
}

test('the same planner yields different plans for different models', () => {
  const allWritable = buildPlan(fleet({
    boxes: [
      { id: 'vav_01', kind: 'flush' },
      { id: 'vav_02', kind: 'setpoint' },
    ],
  }), policy());
  assert.equal(allWritable.ready, true);
  assert.equal(step(allWritable, 'ahu.recirc').status, 'included');
  assert.equal(step(allWritable, 'ahu.economizer').status, 'included');
  assert.equal(step(allWritable, 'vav.max_cool').status, 'included');
  assert.equal(allWritable.capability.vav.boxes_capable, 2);
  assert.deepEqual(
    allWritable.capability.vav.per_box.map((box) => box.strategy),
    ['flush_point', 'airflow_setpoint'],
  );
  assert.ok(allWritable.sample_points.some((item) => item.role === 'outdoor_air_intake_damper_position_command'));

  const mixed = buildPlan(fleet({
    boxes: [
      { id: 'vav_01', kind: 'flush' },
      { id: 'vav_02', kind: 'readonly' },
      { id: 'vav_03', kind: 'max_only' },
    ],
  }), policy());
  assert.equal(step(mixed, 'vav.max_cool').status, 'included');
  assert.equal(mixed.capability.vav.boxes_capable, 1);
  const skipped = mixed.capability.vav.boxes_skipped.map((box) => box.reason);
  assert.ok(skipped.some((reason) => reason.startsWith('model_not_writable')));
  assert.ok(skipped.some((reason) => reason.startsWith('role_unbound')));

  const readOnly = buildPlan(fleet({
    boxes: [
      { id: 'vav_01', kind: 'readonly' },
      { id: 'vav_02', kind: 'readonly' },
    ],
  }), policy());
  assert.equal(step(readOnly, 'vav.max_cool').status, 'skipped');
  assert.equal(step(readOnly, 'vav.max_cool').skip_reason, 'insufficient_capability');
  assert.equal(readOnly.capability.vav.boxes_capable, 0);
  assert.equal(step(readOnly, 'ahu.recirc').status, 'included');

  const noEconomizer = buildPlan(fleet({
    damper: false,
    boxes: [{ id: 'vav_01', kind: 'setpoint' }],
  }), policy());
  assert.equal(step(noEconomizer, 'ahu.economizer').status, 'skipped');
  assert.match(step(noEconomizer, 'ahu.economizer').skip_reason, /^economizer_points_missing:/);
  assert.equal(step(noEconomizer, 'ahu.recirc').status, 'included');
  assert.ok(step(noEconomizer, 'ahu.recirc').writes.every((write) => write.role !== 'outdoor_air_intake_damper_position_command'));
  assert.equal(step(noEconomizer, 'vav.max_cool').status, 'included');
});

test('interlocks and box limits come from the model and the policy', () => {
  const withFreeze = buildPlan(fleet({
    freeze: true,
    boxes: [{ id: 'vav_01', kind: 'flush' }, { id: 'vav_02', kind: 'flush' }],
  }), policy());
  const withoutFreeze = buildPlan(fleet({
    boxes: [{ id: 'vav_01', kind: 'flush' }],
  }), policy());
  assert.ok(withFreeze.interlocks.includes('freeze_protection'));
  assert.equal(withoutFreeze.interlocks.includes('freeze_protection'), false);
  assert.ok(withFreeze.interlocks.includes('zone_out_of_band'));
  assert.ok(withFreeze.sample_points.length > withoutFreeze.sample_points.length);

  const limited = buildPlan(fleet({
    boxes: [{ id: 'vav_01', kind: 'flush' }, { id: 'vav_02', kind: 'setpoint' }],
  }), policy({ limits: { max_boxes_overridden: 1 } }));
  assert.equal(limited.capability.vav.boxes_capable, 1);
  assert.ok(limited.capability.vav.boxes_skipped.some((box) => box.reason === 'over_box_limit'));
});

test('a config writable flag cannot promote a read-only model point', () => {
  assert.deepEqual(
    evaluateWrite({ role: 'cooling_valve_position_command', writable: false }, { writable: true }),
    { ok: false, reason: 'model_not_writable' },
  );
  assert.deepEqual(
    evaluateWrite({ role: 'cooling_valve_position_command', writable: true }, { writable: true }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateWrite({ role: 'cooling_valve_position_command', writable: true }, undefined),
    { ok: true },
  );
  assert.deepEqual(
    evaluateWrite({ role: 'supply_fan_operating_status', writable: true }, undefined),
    { ok: false, reason: 'role_not_writable' },
  );
  assert.deepEqual(confirmRuntime({ writable: false }, { priority_array: true }), { ok: false, reason: 'model_not_writable' });
  assert.deepEqual(confirmRuntime({ writable: true }, { priority_array: false }), { ok: false, reason: 'no_priority_array' });
  assert.deepEqual(confirmRuntime({ writable: true }, { priority_array: true, readback_ok: false }), { ok: false, reason: 'write_not_effective' });
  assert.deepEqual(confirmRuntime({ writable: true }, { priority_array: true, readback_ok: true }), { ok: true });
});

test('an extended haystack map resolves tags the shipped map does not list', () => {
  const map = mergeMaps(loadHaystackMap(), {
    version: 1,
    roles: [{ role: 'outdoor_air_intake_damper_position_command', tags: ['oa', 'dpr', 'cmd'] }],
  });
  const model = loadHaystackModel({
    equipment: [{ id: 'ahu_a', type: 'ahu' }],
    points: [point('ahu_a', ['oa', 'dpr', 'cmd'], 1, true)],
  }, map);
  const bound = model.equipment[0].points.outdoor_air_intake_damper_position_command;
  assert.equal(bound.writable, true);
  assert.equal(bound.uuid, uuid(1));
});

test('haystack still plans when rdf input is refused', () => {
  const haystack = fleet({ damper: false, boxes: [{ id: 'vav_01', kind: 'setpoint' }] });
  const plan = buildPlan(haystack, policy());
  assert.equal(plan.capability.vav.per_box[0].strategy, 'airflow_setpoint');
  assert.throws(() => loadRdfModel('@prefix id: <urn:id:> . id:ahu_a a id:AHU .'), RdfInputDisabledError);
});

test('mode point, bas toggle, and missing sensors change the plan', () => {
  const base = fleet({ boxes: [{ id: 'vav_01', kind: 'flush' }] });
  const ahu = base.equipment.find((item) => item.id === 'ahu_a');
  ahu.points.test_operating_mode_command = {
    role: 'test_operating_mode_command',
    uuid: uuid(40),
    layer: 'hpl:bacnet:1',
    writable: true,
    tags: [],
  };
  const mode = buildPlan(base, policy({ plan: {
    ahu_strategy: 'mode_point',
    steps: [
      { step_id: 'ahu.baseline' },
      { step_id: 'ahu.recirc' },
      { step_id: 'vav.max_cool', enabled: false },
      { step_id: 'ahu.fan_off', enabled: true },
      { step_id: 'recovery' },
    ],
  } }));
  assert.equal(step(mode, 'ahu.recirc').writes[0].role, 'test_operating_mode_command');
  assert.equal(step(mode, 'vav.max_cool').skip_reason, 'disabled');
  assert.equal(step(mode, 'ahu.fan_off').skip_reason, 'step_not_implemented');

  delete ahu.points.test_operating_mode_command.writable;
  ahu.points.test_operating_mode_command.writable = false;
  const blocked = buildPlan(base, policy({ plan: { ahu_strategy: 'mode_point', steps: [{ step_id: 'ahu.recirc' }, { step_id: 'recovery' }] } }));
  assert.equal(step(blocked, 'ahu.recirc').status, 'skipped');

  ahu.points.maximum_cooling_operating_mode_command = {
    role: 'maximum_cooling_operating_mode_command',
    uuid: uuid(41),
    layer: 'hpl:bacnet:1',
    writable: true,
    tags: [],
  };
  const toggled = buildPlan(base, policy({ vav_test: { strategy: 'bas_toggle' } }));
  assert.equal(step(toggled, 'vav.max_cool').status, 'included');
  assert.equal(step(toggled, 'vav.max_cool').boxes[0].strategy, 'bas_toggle');
  ahu.points.maximum_cooling_operating_mode_command.writable = false;
  const noToggle = buildPlan(base, policy({ vav_test: { strategy: 'bas_toggle' } }));
  assert.match(step(noToggle, 'vav.max_cool').skip_reason, /maximum_cooling_operating_mode_command/);

  delete ahu.points.discharge_air_temperature;
  const blind = buildPlan(base, policy());
  assert.equal(blind.ready, false);
  assert.match(blind.reason, /^role_unbound:/);
  assert.equal(step(blind, 'recovery').skip_reason, 'nothing_to_run');
});

test('haystack infers equipment type', () => {
  const inferred = loadHaystackModel({
    equipment: [{ id: 'ahu_a', tags: ['ahu'] }],
    points: [point('vav_09', ['zone', 'air', 'temp', 'sensor'], 3, false)],
  });
  assert.equal(inferred.equipment.find((item) => item.id === 'ahu_a').type, 'ahu');
  assert.equal(inferred.equipment.find((item) => item.id === 'vav_09').type, 'vav');

  const merged = mergeMaps(loadHaystackMap(), {
    roles: [{ role: 'discharge_air_temperature', types: ['DAT'] }, { role: 'note' }],
  });
  assert.equal(merged.roles.some((entry) => entry.role === 'note'), true);
  assert.throws(() => loadRdfModel('@prefix id: <urn:id:> . id:vav_01 id:ahuRef id:ahu_a .'), RdfInputDisabledError);
});

test('planner refuses to guess an ahu when several are present', () => {
  const model = fleet({ boxes: [] });
  model.equipment.push({ id: 'ahu_b', type: 'ahu', serves: [], ahuRef: null, points: {}, tags: [] });
  const plan = buildPlan(model, policy());
  assert.equal(plan.ready, false);
  assert.equal(plan.reason, 'ahu_not_selected');
  const chosen = buildPlan(model, policy({ equipment: [{ id: 'ahu_a', type: 'ahu', points: {} }] }));
  assert.equal(chosen.equipment_id, 'ahu_a');
});
