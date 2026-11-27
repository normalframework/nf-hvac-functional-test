// NF schedule service data (normalgw.hpl.v1 ScheduleManager) read only, plus the operator's test windows.
// Evaluation follows the NF order: out of service, effective period, special events, weekly, default.
// REST JSON is camelCase (GET /api/v1/schedules/{uuid}); the snake_case shapes are accepted too.
// Browser global NfftTimetable, CommonJS in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rrule.js'));
  else root.NfftTimetable = factory(root.NfftRrule);
})(globalThis, function (R) {
  'use strict';

  const WEEKDAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  /**
   * @param {any} obj
   * @param {string} camel
   * @param {string} snake
   */
  function pick(obj, camel, snake) {
    if (!obj || typeof obj !== 'object') return undefined;
    return obj[camel] !== undefined ? obj[camel] : obj[snake];
  }

  /**
   * NF Value ({ boolean | real | unsigned | ... }) or a bare scalar to a JS scalar or null.
   * @param {any} value
   */
  function scalar(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return null;
    for (const key of ['boolean', 'real', 'double', 'unsigned', 'signed', 'enumerated']) {
      if (value[key] !== undefined && value[key] !== null) {
        return key === 'boolean' ? Boolean(value[key]) : Number(value[key]);
      }
    }
    return null;
  }

  /**
   * "08:30", "08:30:00" or { hour, minute } to minutes after local midnight.
   * @param {any} time
   */
  function minutesOf(time) {
    if (typeof time === 'string') {
      const match = /^(\d{1,2}):(\d{2})/.exec(time);
      return match ? Number(match[1]) * 60 + Number(match[2]) : null;
    }
    if (time && typeof time === 'object') return (Number(time.hour) || 0) * 60 + (Number(time.minute) || 0);
    return null;
  }

  /**
   * @param {any[]} list
   */
  function steps(list) {
    return (Array.isArray(list) ? list : [])
      .map((item) => ({ min: minutesOf(item && item.time), value: scalar(item && item.value) }))
      .filter((item) => item.min !== null)
      .sort((a, b) => /** @type {number} */ (a.min) - /** @type {number} */ (b.min));
  }

  /**
   * BACnet date or pattern. A missing or 255 field is "any"; "*" in a string date is "any".
   * day may be "last". Returns null for an unusable date.
   * @param {any} raw
   */
  function datePattern(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') {
      const match = /^(\*|\d{4})-(\*|\d{1,2})-(\*|last|\d{1,2})$/i.exec(raw.trim());
      if (!match) return null;
      const field = (/** @type {string} */ text) => (text === '*' ? null : Number(text));
      return { y: field(match[1]), m: field(match[2]), d: match[3].toLowerCase() === 'last' ? 'last' : field(match[3]) };
    }
    if (typeof raw === 'object') {
      const any = (/** @type {any} */ v) => (v === undefined || v === null || v === 255 || v === 0 ? null : Number(v));
      if (raw.dayOfWeek !== undefined && raw.dayOfWeek !== 255 && raw.dayOfWeek !== 0 && raw.dayOfWeek !== null) {
        return { unsupported: true };
      }
      const y = raw.year === undefined || raw.year === 255 || raw.year === null ? null : Number(raw.year);
      const d = raw.day === 32 || raw.day === 'last' ? 'last' : any(raw.day);
      return { y: y !== null && y < 1900 ? y + 1900 : y, m: any(raw.month), d };
    }
    return null;
  }

  /**
   * @param {any} raw
   */
  function normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const range = pick(raw, 'dateRange', 'date_range');
    const start = range ? pick(range, 'startDate', 'start_date') : pick(raw, 'startDate', 'start_date');
    const end = range ? pick(range, 'endDate', 'end_date') : pick(raw, 'endDate', 'end_date');
    return {
      name: typeof raw.name === 'string' ? raw.name : 'special event',
      priority: Number.isInteger(raw.priority) ? raw.priority : 16,
      date: start ? null : datePattern(raw.date),
      range: start && end ? [datePattern(start), datePattern(end)] : null,
      steps: steps(pick(raw, 'timeValues', 'time_values')),
    };
  }

  /**
   * One normalized shape for the camelCase REST record and the snake_case tool record.
   * @param {any} raw
   */
  function normalizeSchedule(raw) {
    const body = raw && raw.schedule ? raw.schedule : raw;
    if (!body || typeof body !== 'object') return null;
    const weeklyRaw = pick(body, 'weeklySchedule', 'weekly_schedule') || {};
    /** @type {{ min: number | null, value: any }[][]} */
    let weekly;
    if (Array.isArray(weeklyRaw.days)) {
      weekly = WEEKDAY_KEYS.map((_, i) => steps(pick(weeklyRaw.days[i], 'timeValues', 'time_values')));
    } else {
      weekly = WEEKDAY_KEYS.map((key) => steps(weeklyRaw[key]));
    }
    const effective = pick(body, 'effectivePeriod', 'effective_period');
    const effStart = effective ? datePattern(pick(effective, 'startDate', 'start_date')) : null;
    const effEnd = effective ? datePattern(pick(effective, 'endDate', 'end_date')) : null;
    return {
      uuid: typeof body.uuid === 'string' ? body.uuid : '',
      name: typeof body.name === 'string' ? body.name : '',
      defaultValue: scalar(pick(body, 'defaultValue', 'default_value')),
      outOfService: Boolean(pick(body, 'outOfService', 'out_of_service')),
      weekly,
      events: (pick(body, 'specialEvents', 'special_events') || []).map(normalizeEvent).filter(Boolean),
      effective: effStart && effEnd ? [effStart, effEnd] : null,
    };
  }

  /**
   * @param {any} pattern
   * @param {{ y: number, m: number, d: number }} day
   */
  function patternMatches(pattern, day) {
    if (!pattern || pattern.unsupported) return false;
    if (pattern.y !== null && pattern.y !== day.y) return false;
    if (pattern.m !== null && pattern.m !== day.m) return false;
    if (pattern.d === 'last') return day.d === new Date(Date.UTC(day.y, day.m, 0)).getUTCDate();
    if (pattern.d !== null && pattern.d !== day.d) return false;
    return true;
  }

  /**
   * Concrete patterns compare as yyyymmdd; a range with wildcards does not match.
   * @param {any} pattern
   */
  function ordinal(pattern) {
    if (!pattern || pattern.unsupported || pattern.y === null || pattern.m === null || typeof pattern.d !== 'number') return null;
    return pattern.y * 10000 + pattern.m * 100 + pattern.d;
  }

  /**
   * @param {any} event
   * @param {{ y: number, m: number, d: number }} day
   */
  function eventMatches(event, day) {
    if (event.date) return patternMatches(event.date, day);
    if (event.range) {
      const lo = ordinal(event.range[0]);
      const hi = ordinal(event.range[1]);
      if (lo === null || hi === null) return false;
      const at = day.y * 10000 + day.m * 100 + day.d;
      return at >= lo && at <= hi;
    }
    return false;
  }

  /**
   * @param {{ min: number | null, value: any }[]} list
   * @param {number} minute
   */
  function lastAtOrBefore(list, minute) {
    let found;
    for (const item of list) {
      if (/** @type {number} */ (item.min) <= minute) found = item;
    }
    return found;
  }

  /**
   * Effective value at an instant, evaluated in the site timezone.
   * @param {any} schedule normalized
   * @param {number} ms
   * @param {string} tz
   */
  function valueAt(schedule, ms, tz) {
    if (schedule.outOfService) return { value: schedule.defaultValue, source: 'out_of_service', event: null };
    const p = R.localParts(ms, tz);
    const day = { y: p.y, m: p.m, d: p.d };
    const minute = p.h * 60 + p.mi;
    if (schedule.effective) {
      const lo = ordinal(schedule.effective[0]);
      const hi = ordinal(schedule.effective[1]);
      const at = p.y * 10000 + p.m * 100 + p.d;
      if (lo !== null && hi !== null && (at < lo || at > hi)) return { value: null, source: 'outside_effective', event: null };
    }
    const events = schedule.events.filter((/** @type {any} */ event) => eventMatches(event, day))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.priority - b.priority);
    if (events.length) {
      const hit = lastAtOrBefore(events[0].steps, minute);
      return { value: hit ? hit.value : schedule.defaultValue, source: 'event', event: events[0].name };
    }
    const hit = lastAtOrBefore(schedule.weekly[p.dow] || [], minute);
    if (hit) return { value: hit.value, source: 'weekly', event: null };
    return { value: schedule.defaultValue, source: 'default', event: null };
  }

  /**
   * @param {any} value
   */
  function occupied(value) {
    return value === true || (typeof value === 'number' && value > 0);
  }

  /**
   * Occupied blocks per weekday (Mon = 0) from weekly steps, in minutes [start, end).
   * @param {any} schedule normalized
   */
  function occupiedBlocks(schedule) {
    const startOcc = occupied(schedule.defaultValue);
    return schedule.weekly.map((/** @type {any[]} */ list) => {
      /** @type {{ start: number, end: number }[]} */
      const blocks = [];
      let open = startOcc ? 0 : null;
      for (const item of list) {
        if (occupied(item.value) && open === null) open = item.min;
        else if (!occupied(item.value) && open !== null) {
          if (item.min > open) blocks.push({ start: open, end: item.min });
          open = null;
        }
      }
      if (open !== null && open < 1440) blocks.push({ start: open, end: 1440 });
      return blocks;
    });
  }

  /**
   * Test windows: 7 lists (Mon = 0) of { start, end } minutes. Sorted, clipped, merged, 15 minute grid.
   * @param {any} input
   */
  function normalizeWindows(input) {
    const days = Array.isArray(input) ? input : [];
    return WEEKDAY_KEYS.map((_, i) => {
      const list = (Array.isArray(days[i]) ? days[i] : [])
        .map((/** @type {any} */ b) => ({
          start: Math.max(0, Math.min(1440, Math.round(Number(b && b.start) / 15) * 15)),
          end: Math.max(0, Math.min(1440, Math.round(Number(b && b.end) / 15) * 15)),
        }))
        .filter((/** @type {any} */ b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
        .sort((/** @type {any} */ a, /** @type {any} */ b) => a.start - b.start);
      /** @type {{ start: number, end: number }[]} */
      const merged = [];
      for (const block of list) {
        const last = merged[merged.length - 1];
        if (last && block.start <= last.end) last.end = Math.max(last.end, block.end);
        else merged.push({ ...block });
      }
      return merged;
    });
  }

  /**
   * True when no window is set (any time is allowed) or the instant falls inside one.
   * @param {any} windows normalized
   * @param {number} ms
   * @param {string} tz
   */
  function inWindow(windows, ms, tz) {
    const any = windows.some((/** @type {any[]} */ day) => day.length > 0);
    if (!any) return true;
    const p = R.localParts(ms, tz);
    const minute = p.h * 60 + p.mi;
    return windows[p.dow].some((/** @type {any} */ b) => minute >= b.start && minute < b.end);
  }

  /**
   * Blackout gate for a run at ms. A configured schedule that could not be read blocks the run.
   * @param {{ schedule: any, configured: boolean, block_when_occupied: boolean, block_on_special_event: boolean }} gate
   * @param {number} ms
   * @param {string} tz
   */
  function blackout(gate, ms, tz) {
    if (!gate.configured) return { blocked: false, reason: null };
    if (!gate.schedule) return { blocked: true, reason: 'blackout_schedule_unavailable' };
    const result = valueAt(gate.schedule, ms, tz);
    if (gate.block_on_special_event && result.source === 'event') return { blocked: true, reason: `special_event:${result.event}` };
    if (gate.block_when_occupied && occupied(result.value)) return { blocked: true, reason: 'occupied' };
    return { blocked: false, reason: null };
  }

  return {
    WEEKDAY_KEYS,
    scalar,
    normalizeSchedule,
    valueAt,
    occupied,
    occupiedBlocks,
    normalizeWindows,
    inWindow,
    blackout,
    eventMatches,
    datePattern,
  };
});
