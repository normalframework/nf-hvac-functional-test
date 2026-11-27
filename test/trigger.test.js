'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Trigger = require('../static/js/core/trigger.js');
const T = require('../static/js/core/timetable.js');

const CHI = 'America/Chicago';
const NOON = Date.parse('2026-11-26T18:00:00Z');
const rule = { kind: 'monthly_last', weekday: 3, hour: 12, minute: 0, tz: CHI };

test('the default trigger is disabled and never starts a run', () => {
  const doc = Trigger.defaults();
  assert.equal(doc.mode, 'disabled');
  assert.deepEqual(Trigger.decide(doc, { now: NOON }), { action: 'none', live: false, occurrence: null, reason: 'disabled' });
  assert.equal(Trigger.normalize({ mode: 'armed' }).mode, 'dry_run');
  assert.equal(Trigger.normalize({ mode: 'bogus' }).mode, 'disabled');
  assert.equal(Trigger.normalize({ mode: 'armed', armed: { at: 1 }, rule: { kind: 'x' } }).mode, 'dry_run');
  assert.equal(Trigger.normalize(null).rule.kind, 'monthly_last');
});

test('arming needs confirm and the typed phrase', () => {
  const base = Trigger.apply(Trigger.defaults(), { op: 'save', rule, now: 0 });
  assert.equal(base.ok, true);
  const doc = /** @type {any} */ (base).doc;
  assert.equal(Trigger.apply(doc, { op: 'arm', confirm: true, phrase: 'arm', now: 1 }).ok, false);
  assert.equal(Trigger.apply(doc, { op: 'arm', confirm: 'true', phrase: 'ARM', now: 1 }).ok, false);
  const armed = Trigger.apply(doc, { op: 'arm', confirm: true, phrase: 'ARM', now: 5, by: 'operator' });
  assert.equal(armed.ok, true);
  const armedDoc = /** @type {any} */ (armed).doc;
  assert.equal(armedDoc.mode, 'armed');
  assert.deepEqual(armedDoc.armed, { at: 5, by: 'operator' });
  // Any change to what or when disarms back to dry-run.
  const edited = /** @type {any} */ (Trigger.apply(armedDoc, { op: 'save', rule: { ...rule, hour: 13 }, now: 6 }));
  assert.equal(edited.doc.mode, 'dry_run');
  assert.equal(edited.note, 'disarmed_on_change');
  const same = /** @type {any} */ (Trigger.apply(armedDoc, { op: 'save', rule, now: 6 }));
  assert.equal(same.doc.mode, 'armed');
  assert.equal(/** @type {any} */ (Trigger.apply(armedDoc, { op: 'disable', now: 7 })).doc.mode, 'disabled');
  assert.equal(/** @type {any} */ (Trigger.apply(armedDoc, { op: 'dry_run', now: 7 })).doc.armed, null);
  assert.equal(Trigger.apply(doc, { op: 'save', rule: { kind: 'x' }, now: 0 }).ok, false);
  assert.equal(Trigger.apply(doc, { op: 'launch', now: 0 }).ok, false);
});

test('decide: due, windows, blackout, and once per occurrence', () => {
  const dry = Trigger.normalize({ mode: 'dry_run', rule });
  assert.equal(Trigger.decide(dry, { now: NOON - 60000 }).reason, 'not_due');
  assert.deepEqual(Trigger.decide(dry, { now: NOON + 60000 }), { action: 'start', live: false, occurrence: NOON, reason: 'dry_run' });
  const armed = Trigger.normalize({ mode: 'armed', armed: { at: 1, by: '' }, rule });
  assert.equal(Trigger.decide(armed, { now: NOON }).live, true);
  const recorded = Trigger.record(dry, Trigger.decide(dry, { now: NOON }), NOON, 'run1');
  assert.equal(recorded.history.length, 1);
  assert.equal(Trigger.decide(recorded, { now: NOON + 1000 }).reason, 'already_handled');
  assert.equal(Trigger.record(dry, { action: 'none', live: false, occurrence: null, reason: 'x' }, 0).history.length, 0);

  const windowed = Trigger.normalize({ mode: 'dry_run', rule, windows: [[], [], [], [{ start: 13 * 60, end: 15 * 60 }]] });
  assert.equal(Trigger.decide(windowed, { now: NOON }).reason, 'outside_window');

  const gated = Trigger.normalize({ mode: 'armed', armed: { at: 1 }, rule, blackout: { schedule_uuid: 'sched-1' } });
  assert.equal(Trigger.decide(gated, { now: NOON, scheduleError: true }).reason, 'blackout_schedule_unavailable');
  const holiday = T.normalizeSchedule({ defaultValue: false, specialEvents: [{ name: 'Holiday', date: { year: 2026, month: 11, day: 26 }, timeValues: [] }] });
  assert.equal(Trigger.decide(gated, { now: NOON, schedule: holiday }).reason, 'special_event:Holiday');
  const open = T.normalizeSchedule({ defaultValue: false });
  assert.equal(Trigger.decide(gated, { now: NOON, schedule: open }).action, 'start');
});

test('preview marks runs the window or blackout would skip', () => {
  const doc = Trigger.normalize({ mode: 'dry_run', rule, windows: [[], [], [], [{ start: 11 * 60, end: 13 * 60 }]], blackout: { schedule_uuid: 's' } });
  const from = Date.parse('2026-11-01T00:00:00Z');
  const plain = Trigger.preview(doc, from);
  assert.equal(plain.length, 6);
  assert.equal(plain[0].local, 'Thu 2026-11-26 12:00');
  assert.equal(plain[0].utc, '2026-11-26 18:00 UTC');
  assert.equal(plain[0].runs, true);
  assert.equal(plain[0].blackout, 'checked_at_run');
  const holiday = T.normalizeSchedule({ defaultValue: false, specialEvents: [{ name: 'Holiday', date: { year: 2026, month: 11, day: 26 }, timeValues: [] }] });
  const checked = Trigger.preview(doc, from, holiday, 2);
  assert.equal(checked[0].reason, 'special_event:Holiday');
  assert.equal(checked[1].runs, true);
  assert.equal(Trigger.preview(doc, from, null, 1)[0].reason, 'blackout_schedule_unavailable');
  const narrow = Trigger.normalize({ rule, windows: [[], [], [], [{ start: 0, end: 60 }]] });
  assert.equal(Trigger.preview(narrow, from, undefined, 1)[0].reason, 'outside_window');
  assert.equal(Trigger.preview(narrow, from, undefined, 1)[0].blackout, 'none');
});
