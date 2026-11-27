import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../static/timetable.js');

const CHI = 'America/Chicago';
const at = (text) => Date.parse(text);

// REST shape (camelCase): Monday-Friday 07:00-18:00 occupied, a holiday, a recurring date and a range.
const REST = {
  schedule: {
    uuid: 'sched-1',
    name: 'Occupancy',
    defaultValue: { boolean: false },
    weeklySchedule: {
      days: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
        timeValues: i < 5
          ? [{ time: { hour: 18, minute: 0 }, value: { boolean: false } }, { time: { hour: 7, minute: 0 }, value: { boolean: true } }]
          : [],
      })),
    },
    specialEvents: [
      { name: 'Holiday', priority: 3, date: { year: 2026, month: 11, day: 26 }, timeValues: [] },
      { name: 'Open house', priority: 5, date: { year: 2026, month: 11, day: 26 }, timeValues: [{ time: { hour: 0, minute: 0 }, value: { boolean: true } }] },
      { name: 'Every 25 Dec', priority: 1, date: { year: 255, month: 12, day: 25 }, timeValues: [] },
      { name: 'Shutdown', priority: 2, dateRange: { startDate: { year: 2026, month: 12, day: 28 }, endDate: { year: 2026, month: 12, day: 30 } }, timeValues: [] },
      { name: 'Month end', priority: 4, date: { year: 255, month: 255, day: 32 }, timeValues: [{ time: { hour: 6, minute: 0 }, value: { real: 1 } }] },
      { name: 'Weekday pattern', priority: 1, date: { year: 255, month: 255, day: 255, dayOfWeek: 4 }, timeValues: [] },
    ],
  },
};

test('REST and tool shapes normalize the same weekly steps', () => {
  const rest = /** @type {any} */ (T.normalizeSchedule(REST));
  const tool = /** @type {any} */ (T.normalizeSchedule({
    name: 'Occupancy',
    default_value: false,
    weekly_schedule: { monday: [{ time: '07:00', value: true }, { time: '18:00', value: false }] },
    special_events: [{ name: 'X', date: '*-12-25', time_values: [] }, { name: 'Y', start_date: '2026-12-28', end_date: '2026-12-30', time_values: [] }],
    effective_period: { start_date: '2026-01-01', end_date: '2026-12-31' },
  }));
  assert.deepEqual(rest.weekly[0], tool.weekly[0]);
  assert.equal(rest.defaultValue, false);
  assert.equal(tool.events[0].date.y, null);
  assert.deepEqual(tool.effective[1], { y: 2026, m: 12, d: 31 });
  assert.equal(T.normalizeSchedule(null), null);
  assert.deepEqual(T.occupiedBlocks(rest)[0], [{ start: 420, end: 1080 }]);
  assert.deepEqual(T.occupiedBlocks(rest)[5], []);
  assert.deepEqual(T.occupiedBlocks({ defaultValue: 1, weekly: [[{ min: 600, value: 0 }]] })[0], [{ start: 0, end: 600 }]);
});

test('evaluation follows the NF order', () => {
  const s = /** @type {any} */ (T.normalizeSchedule(REST));
  assert.deepEqual(T.valueAt(s, at('2026-11-24T15:00:00Z'), CHI), { value: true, source: 'weekly', event: null });
  assert.deepEqual(T.valueAt(s, at('2026-11-24T12:00:00Z'), CHI), { value: false, source: 'default', event: null });
  // Two events on one day: the lower priority number wins, and an event with no steps is closed.
  assert.deepEqual(T.valueAt(s, at('2026-11-26T18:00:00Z'), CHI), { value: false, source: 'event', event: 'Holiday' });
  assert.equal(T.valueAt(s, at('2027-12-25T18:00:00Z'), CHI).event, 'Every 25 Dec');
  assert.equal(T.valueAt(s, at('2026-12-29T18:00:00Z'), CHI).event, 'Shutdown');
  assert.equal(T.valueAt(s, at('2026-11-30T18:00:00Z'), CHI).event, 'Month end');
  assert.equal(T.valueAt(s, at('2026-11-30T18:00:00Z'), CHI).value, 1);
  // A pattern that needs a day of week is not supported and never matches.
  assert.equal(T.valueAt(s, at('2026-11-27T18:00:00Z'), CHI).source, 'weekly');
  assert.equal(T.valueAt({ ...s, outOfService: true }, at('2026-11-24T15:00:00Z'), CHI).source, 'out_of_service');
  const bounded = { ...s, effective: [{ y: 2026, m: 1, d: 1 }, { y: 2026, m: 6, d: 30 }] };
  assert.deepEqual(T.valueAt(bounded, at('2026-11-24T15:00:00Z'), CHI), { value: null, source: 'outside_effective', event: null });
  assert.equal(T.occupied(0), false);
  assert.equal(T.occupied(2), true);
  assert.equal(T.scalar({ unsigned: '3' }), 3);
  assert.equal(T.scalar('x'), null);
  assert.equal(T.datePattern('bad'), null);
  assert.equal(T.datePattern(7), null);
  assert.deepEqual(T.datePattern('2026-*-last'), { y: 2026, m: null, d: 'last' });
  assert.equal(T.eventMatches({ range: [{ y: null, m: 1, d: 1 }, { y: 2026, m: 1, d: 2 }] }, { y: 2026, m: 1, d: 1 }), false);
  assert.equal(T.eventMatches({}, { y: 2026, m: 1, d: 1 }), false);
});

test('test windows merge on a 15 minute grid and gate by local time', () => {
  const windows = T.normalizeWindows([[{ start: 600, end: 700 }, { start: 690, end: 800 }, { start: 5, end: 5 }], [], [], [{ start: 660, end: 780 }]]);
  assert.deepEqual(windows[0], [{ start: 600, end: 795 }]);
  assert.equal(windows.length, 7);
  assert.equal(T.inWindow(windows, at('2026-11-26T18:00:00Z'), CHI), true);
  assert.equal(T.inWindow(windows, at('2026-11-26T20:00:00Z'), CHI), false);
  assert.equal(T.inWindow(T.normalizeWindows(null), at('2026-11-26T20:00:00Z'), CHI), true);
});

test('blackout fails closed when the configured schedule is unavailable', () => {
  const s = /** @type {any} */ (T.normalizeSchedule(REST));
  const gate = { configured: true, schedule: s, block_when_occupied: true, block_on_special_event: true };
  assert.deepEqual(T.blackout(gate, at('2026-11-26T18:00:00Z'), CHI), { blocked: true, reason: 'special_event:Holiday' });
  assert.deepEqual(T.blackout(gate, at('2026-11-24T18:00:00Z'), CHI), { blocked: true, reason: 'occupied' });
  assert.deepEqual(T.blackout(gate, at('2026-11-28T18:00:00Z'), CHI), { blocked: false, reason: null });
  assert.deepEqual(T.blackout({ ...gate, schedule: null }, 0, CHI), { blocked: true, reason: 'blackout_schedule_unavailable' });
  assert.deepEqual(T.blackout({ ...gate, configured: false }, 0, CHI), { blocked: false, reason: null });
  assert.equal(T.blackout({ ...gate, block_when_occupied: false }, at('2026-11-24T18:00:00Z'), CHI).blocked, false);
});
