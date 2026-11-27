import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../static/rrule.js');

const CHI = 'America/Chicago';
const lastThu = (tz) => ({ kind: 'monthly_last', weekday: 3, hour: 12, minute: 0, tz });
const iso = (ms) => new Date(ms).toISOString();
const norm = (rule) => /** @type {any} */ (R.normalizeRule(rule)).rule;

test('last Thursday at noon renders as an NF hook rule with DTSTART on its own line', () => {
  const out = R.toRrule(lastThu(CHI));
  assert.equal(out.text, 'DTSTART;TZID=America/Chicago:20260101T120000\nRRULE:FREQ=MONTHLY;BYDAY=-1TH;BYHOUR=12;BYMINUTE=0;BYSECOND=0');
  assert.equal(out.utc_dtstart, 'DTSTART:20260101T180000Z');
  assert.equal(R.toRrule(lastThu('UTC')).dtstart, 'DTSTART:20260101T120000Z');
  assert.equal(R.describe(lastThu(CHI)), 'Last Thursday of every month at 12:00 (America/Chicago)');
  assert.deepEqual(R.parseRrule(out.text), norm(lastThu(CHI)));
});

test('last Thursday crosses month ends, five-Thursday months, and the year boundary', () => {
  const runs = R.nextRuns(lastThu(CHI), Date.parse('2026-03-27T00:00:00Z'), 10).map((ms) => R.formatLocal(ms, CHI));
  assert.deepEqual(runs, [
    'Thu 2026-04-30 12:00',
    'Thu 2026-05-28 12:00',
    'Thu 2026-06-25 12:00',
    'Thu 2026-07-30 12:00',
    'Thu 2026-08-27 12:00',
    'Thu 2026-09-24 12:00',
    'Thu 2026-10-29 12:00',
    'Thu 2026-11-26 12:00',
    'Thu 2026-12-31 12:00',
    'Thu 2027-01-28 12:00',
  ]);
});

test('noon stays local noon across daylight saving changes', () => {
  const runs = R.nextRuns(lastThu(CHI), Date.parse('2026-01-01T00:00:00Z'), 12).map(iso);
  assert.equal(runs[1], '2026-02-26T18:00:00.000Z');
  assert.equal(runs[2], '2026-03-26T17:00:00.000Z');
  assert.equal(runs[9], '2026-10-29T17:00:00.000Z');
  assert.equal(runs[10], '2026-11-26T18:00:00.000Z');
  // Europe changes on the last Sunday of March, after the last Thursday.
  const london = R.nextRuns(lastThu('Europe/London'), Date.parse('2026-03-01T00:00:00Z'), 2).map(iso);
  assert.deepEqual(london, ['2026-03-26T12:00:00.000Z', '2026-04-30T11:00:00.000Z']);
  // A start inside the skipped hour moves later by the gap; the repeated hour takes the first instant.
  assert.equal(iso(R.zonedToUtc(2026, 3, 8, 2, 30, CHI)), '2026-03-08T08:30:00.000Z');
  assert.equal(iso(R.zonedToUtc(2026, 11, 1, 1, 30, CHI)), '2026-11-01T06:30:00.000Z');
});

test('weekly, nth weekday and one-off presets', () => {
  const weekly = { kind: 'weekly', weekdays: [1, 3], interval: 2, hour: 6, minute: 30, tz: CHI, start_date: '2026-11-02' };
  assert.equal(R.toRrule(weekly).rrule, 'RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=TU,TH;BYHOUR=6;BYMINUTE=30;BYSECOND=0');
  assert.equal(R.describe(weekly), 'Every 2 weeks on Tuesday and Thursday at 06:30 (America/Chicago)');
  assert.deepEqual(R.nextRuns(weekly, Date.parse('2026-11-01T00:00:00Z'), 4).map((ms) => R.formatLocal(ms, CHI)), [
    'Tue 2026-11-03 06:30', 'Thu 2026-11-05 06:30', 'Tue 2026-11-17 06:30', 'Thu 2026-11-19 06:30',
  ]);
  assert.equal(R.describe({ kind: 'weekly', weekdays: [4], hour: 9, minute: 0, tz: 'UTC' }), 'Every Friday at 09:00 (UTC)');
  assert.deepEqual(R.parseRrule(R.toRrule(weekly).text), norm(weekly));

  const fourth = { kind: 'monthly_nth', nth: 4, weekday: 0, hour: 7, minute: 0, tz: 'UTC' };
  assert.equal(R.toRrule(fourth).rrule, 'RRULE:FREQ=MONTHLY;BYDAY=4MO;BYHOUR=7;BYMINUTE=0;BYSECOND=0');
  assert.deepEqual(R.nextRuns(fourth, Date.parse('2026-11-01T00:00:00Z'), 2).map(iso), ['2026-11-23T07:00:00.000Z', '2026-12-28T07:00:00.000Z']);
  assert.equal(R.describe(fourth), 'Fourth Monday of every month at 07:00 (UTC)');
  assert.deepEqual(R.parseRrule(R.toRrule(fourth).text), norm(fourth));

  const once = { kind: 'once', date: '2026-12-03', hour: 10, minute: 15, tz: CHI };
  assert.equal(R.toRrule(once).text, 'DTSTART;TZID=America/Chicago:20261203T101500\nRRULE:FREQ=DAILY;COUNT=1');
  assert.deepEqual(R.nextRuns(once, Date.parse('2026-11-27T00:00:00Z')).map(iso), ['2026-12-03T16:15:00.000Z']);
  assert.deepEqual(R.nextRuns(once, Date.parse('2026-12-04T00:00:00Z')), []);
  assert.equal(R.describe(once), 'Once on 2026-12-03 at 10:15 (America/Chicago)');
  assert.equal(R.parseRrule(R.toRrule(once).text).kind, 'once');
});

test('nth weekday helper and the start date floor', () => {
  assert.equal(R.nthWeekday(2026, 4, 3, -1), 30);
  assert.equal(R.nthWeekday(2026, 2, 6, -1), 22);
  assert.equal(R.nthWeekday(2026, 10, 3, 1), 1);
  assert.equal(R.nthWeekday(2026, 2, 0, 4), 23);
  const later = { ...lastThu('UTC'), start_date: '2026-06-01' };
  assert.equal(iso(R.nextRuns(later, Date.parse('2026-01-01T00:00:00Z'), 1)[0]), '2026-06-25T12:00:00.000Z');
});

test('due occurrence is inside the tolerance window only', () => {
  const rule = lastThu(CHI);
  const at = Date.parse('2026-11-26T18:00:00Z');
  assert.equal(R.dueOccurrence(rule, at, 600000), at);
  assert.equal(R.dueOccurrence(rule, at + 9 * 60000, 600000), at);
  assert.equal(R.dueOccurrence(rule, at + 11 * 60000, 600000), null);
  assert.equal(R.dueOccurrence(rule, at - 1000, 600000), null);
});

test('invalid rules are refused with field names', () => {
  const bad = R.normalizeRule({ kind: 'weekly', weekdays: [], hour: 24, minute: -1, tz: 'Mars/Base', start_date: '2026-02-30' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.sort(), ['hour', 'minute', 'start_date', 'tz', 'weekdays']);
  assert.equal(R.normalizeRule({ kind: 'monthly_nth', nth: 5, weekday: 9 }).ok, false);
  assert.equal(R.normalizeRule({ kind: 'once', date: 'soon' }).ok, false);
  assert.equal(R.normalizeRule({ kind: 'yearly' }).ok, false);
  assert.equal(R.normalizeRule(null).ok, false);
  assert.throws(() => R.toRrule({ kind: 'nope' }), /invalid rule/);
  assert.deepEqual(R.nextRuns({ kind: 'nope' }, 0), []);
  assert.equal(R.describe({ kind: 'nope' }), 'Invalid schedule');
  assert.equal(R.parseRrule('RRULE:FREQ=MONTHLY'), null);
  assert.equal(R.parseRrule('DTSTART:2026\nRRULE:FREQ=MONTHLY;BYDAY=-1TH'), null);
  assert.equal(R.parseRrule('DTSTART:20260101T000000Z\nRRULE:FREQ=MONTHLY;BYDAY=5TH'), null);
  assert.equal(R.parseRrule('DTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=1'), null);
  assert.equal(R.parseRrule(/** @type {any} */ (42)), null);
  assert.equal(R.validTimezone(''), false);
  assert.equal(R.formatUtc(Date.parse('2026-11-26T18:00:00Z')), '2026-11-26 18:00 UTC');
});
