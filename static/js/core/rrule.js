// Recurrence rules for scheduled functional tests. One file for the browser (global NfftRrule)
// and Node (CommonJS), no dependencies. Times are wall-clock in the site timezone, so a noon test
// stays at noon across daylight saving changes. The NF hook text uses DTSTART on its own line.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NfftRrule = factory();
})(globalThis, function () {
  'use strict';

  const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const ORDINALS = { 1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', '-1': 'Last' };
  const KINDS = ['weekly', 'monthly_nth', 'monthly_last', 'once'];
  const DAY_MS = 24 * 3600 * 1000;

  /** @type {Map<string, Intl.DateTimeFormat>} */
  const formats = new Map();

  /**
   * @param {string} tz
   */
  function formatter(tz) {
    let found = formats.get(tz);
    if (!found) {
      found = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
      formats.set(tz, found);
    }
    return found;
  }

  /**
   * @param {unknown} tz
   */
  function validTimezone(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try {
      formatter(tz);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Civil parts of an instant in tz. dow: Monday = 0.
   * @param {number} ms
   * @param {string} tz
   */
  function localParts(ms, tz) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const part of formatter(tz).formatToParts(new Date(ms))) {
      if (part.type !== 'literal') out[part.type] = Number(part.value);
    }
    const y = out.year;
    const m = out.month;
    const d = out.day;
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    return { y, m, d, h: out.hour % 24, mi: out.minute, s: out.second, dow };
  }

  /**
   * Offset of tz from UTC at an instant, in ms.
   * @param {number} ms
   * @param {string} tz
   */
  function offsetAt(ms, tz) {
    const p = localParts(ms, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }

  /**
   * UTC instant for a wall-clock time in tz. A time skipped by a spring-forward change moves later by the gap.
   * @param {number} y
   * @param {number} m 1-12
   * @param {number} d
   * @param {number} h
   * @param {number} mi
   * @param {string} tz
   */
  function zonedToUtc(y, m, d, h, mi, tz) {
    const wall = Date.UTC(y, m - 1, d, h, mi, 0);
    let guess = wall - offsetAt(wall, tz);
    const second = wall - offsetAt(guess, tz);
    if (second !== guess) guess = Math.max(guess, second);
    return guess;
  }

  /**
   * @param {number} y
   * @param {number} m 1-12
   */
  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /**
   * @param {number} y
   * @param {number} m
   * @param {number} d
   */
  function dowOf(y, m, d) {
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  }

  /**
   * Day of month for the nth (1-4, or -1 for last) weekday of a month, or null.
   * @param {number} y
   * @param {number} m
   * @param {number} weekday Monday = 0
   * @param {number} nth
   */
  function nthWeekday(y, m, weekday, nth) {
    if (nth === -1) {
      const last = daysInMonth(y, m);
      const back = (dowOf(y, m, last) - weekday + 7) % 7;
      return last - back;
    }
    const first = (weekday - dowOf(y, m, 1) + 7) % 7 + 1;
    const day = first + (nth - 1) * 7;
    return day <= daysInMonth(y, m) ? day : null;
  }

  /**
   * @param {unknown} text
   */
  function parseDate(text) {
    if (typeof text !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return { y, m, d };
  }

  /**
   * @param {unknown} value
   * @param {number} lo
   * @param {number} hi
   */
  function intIn(value, lo, hi) {
    return Number.isInteger(value) && /** @type {number} */ (value) >= lo && /** @type {number} */ (value) <= hi;
  }

  function defaultRule() {
    return { kind: 'monthly_last', weekday: 3, hour: 12, minute: 0, tz: 'UTC', start_date: '2026-01-01' };
  }

  /**
   * Validate and fill a rule. Unknown fields are dropped.
   * @param {any} input
   * @returns {{ ok: true, rule: any } | { ok: false, errors: string[] }}
   */
  function normalizeRule(input) {
    const raw = input && typeof input === 'object' ? input : {};
    /** @type {string[]} */
    const errors = [];
    const kind = KINDS.includes(raw.kind) ? raw.kind : null;
    if (!kind) errors.push('kind');
    const tz = raw.tz === undefined ? 'UTC' : raw.tz;
    if (!validTimezone(tz)) errors.push('tz');
    const hour = raw.hour === undefined ? 12 : raw.hour;
    const minute = raw.minute === undefined ? 0 : raw.minute;
    if (!intIn(hour, 0, 23)) errors.push('hour');
    if (!intIn(minute, 0, 59)) errors.push('minute');
    const startDate = raw.start_date === undefined ? '2026-01-01' : raw.start_date;
    if (!parseDate(startDate)) errors.push('start_date');
    /** @type {any} */
    const rule = { kind, hour, minute, tz, start_date: startDate };
    if (kind === 'weekly') {
      const days = Array.isArray(raw.weekdays) ? [...new Set(raw.weekdays)].sort() : [];
      if (days.length === 0 || days.some((day) => !intIn(day, 0, 6))) errors.push('weekdays');
      const interval = raw.interval === undefined ? 1 : raw.interval;
      if (!intIn(interval, 1, 52)) errors.push('interval');
      rule.weekdays = days;
      rule.interval = interval;
    }
    if (kind === 'monthly_nth' || kind === 'monthly_last') {
      if (!intIn(raw.weekday, 0, 6)) errors.push('weekday');
      rule.weekday = raw.weekday;
      if (kind === 'monthly_nth') {
        if (!intIn(raw.nth, 1, 4)) errors.push('nth');
        rule.nth = raw.nth;
      }
    }
    if (kind === 'once') {
      if (!parseDate(raw.date)) errors.push('date');
      rule.date = raw.date;
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, rule };
  }

  /**
   * @param {number} n
   */
  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /**
   * @param {number} ms
   */
  function utcStamp(ms) {
    const t = new Date(ms);
    return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
  }

  /**
   * NF scheduled-hook text: DTSTART on its own line, then the RRULE. BYHOUR is site-local through TZID.
   * utc_dtstart is the same first instant in UTC, shown next to it.
   * @param {any} input
   */
  function toRrule(input) {
    const checked = normalizeRule(input);
    if (!checked.ok) throw new Error(`invalid rule: ${checked.errors.join(',')}`);
    const rule = checked.rule;
    const start = rule.kind === 'once' ? parseDate(rule.date) : parseDate(rule.start_date);
    const s = /** @type {{ y: number, m: number, d: number }} */ (start);
    const local = `${s.y}${pad(s.m)}${pad(s.d)}T${pad(rule.hour)}${pad(rule.minute)}00`;
    const dtstart = rule.tz === 'UTC' ? `DTSTART:${local}Z` : `DTSTART;TZID=${rule.tz}:${local}`;
    const at = `BYHOUR=${rule.hour};BYMINUTE=${rule.minute};BYSECOND=0`;
    let body;
    if (rule.kind === 'weekly') {
      const days = rule.weekdays.map((/** @type {number} */ day) => DAY_CODES[day]).join(',');
      body = `FREQ=WEEKLY;INTERVAL=${rule.interval};WKST=MO;BYDAY=${days};${at}`;
    } else if (rule.kind === 'monthly_nth') {
      body = `FREQ=MONTHLY;BYDAY=${rule.nth}${DAY_CODES[rule.weekday]};${at}`;
    } else if (rule.kind === 'monthly_last') {
      body = `FREQ=MONTHLY;BYDAY=-1${DAY_CODES[rule.weekday]};${at}`;
    } else {
      body = 'FREQ=DAILY;COUNT=1';
    }
    const first = zonedToUtc(s.y, s.m, s.d, rule.hour, rule.minute, rule.tz);
    const rrule = `RRULE:${body}`;
    return { dtstart, rrule, text: `${dtstart}\n${rrule}`, utc_dtstart: `DTSTART:${utcStamp(first)}` };
  }

  /**
   * Parse the subset this module writes. Returns null for anything else.
   * @param {string} text
   * @param {string} [fallbackTz]
   */
  function parseRrule(text, fallbackTz) {
    if (typeof text !== 'string') return null;
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const startLine = lines.find((line) => line.startsWith('DTSTART'));
    const ruleLine = lines.find((line) => line.startsWith('RRULE:'));
    if (!startLine || !ruleLine) return null;
    const start = /^DTSTART(?:;TZID=([^:]+))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(startLine);
    if (!start) return null;
    const tz = start[1] || (start[8] ? 'UTC' : fallbackTz || 'UTC');
    /** @type {Record<string, string>} */
    const parts = {};
    for (const item of ruleLine.slice(6).split(';')) {
      const [key, value] = item.split('=');
      if (key && value !== undefined) parts[key] = value;
    }
    const date = `${start[2]}-${start[3]}-${start[4]}`;
    const hour = parts.BYHOUR !== undefined ? Number(parts.BYHOUR) : Number(start[5]);
    const minute = parts.BYMINUTE !== undefined ? Number(parts.BYMINUTE) : Number(start[6]);
    /** @type {any} */
    let rule = null;
    if (parts.FREQ === 'WEEKLY' && parts.BYDAY) {
      rule = {
        kind: 'weekly',
        weekdays: parts.BYDAY.split(',').map((code) => DAY_CODES.indexOf(code)),
        interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
      };
    } else if (parts.FREQ === 'MONTHLY' && parts.BYDAY) {
      const match = /^(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)$/.exec(parts.BYDAY);
      if (!match) return null;
      const weekday = DAY_CODES.indexOf(match[2]);
      rule = match[1] === '-1' ? { kind: 'monthly_last', weekday } : { kind: 'monthly_nth', nth: Number(match[1]), weekday };
    } else if (parts.FREQ === 'DAILY' && parts.COUNT === '1') {
      rule = { kind: 'once', date };
    }
    if (!rule) return null;
    const checked = normalizeRule({ ...rule, hour, minute, tz, start_date: date });
    return checked.ok ? checked.rule : null;
  }

  /**
   * @param {number} hour
   * @param {number} minute
   */
  function clock(hour, minute) {
    return `${pad(hour)}:${pad(minute)}`;
  }

  /**
   * The rule in plain words.
   * @param {any} input
   */
  function describe(input) {
    const checked = normalizeRule(input);
    if (!checked.ok) return 'Invalid schedule';
    const rule = checked.rule;
    const at = `at ${clock(rule.hour, rule.minute)} (${rule.tz})`;
    if (rule.kind === 'weekly') {
      const names = rule.weekdays.map((/** @type {number} */ day) => DAY_NAMES[day]);
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      const every = rule.interval === 1 ? 'Every' : `Every ${rule.interval} weeks on`;
      return `${every} ${list} ${at}`;
    }
    if (rule.kind === 'monthly_nth' || rule.kind === 'monthly_last') {
      const nth = rule.kind === 'monthly_last' ? -1 : rule.nth;
      return `${ORDINALS[nth]} ${DAY_NAMES[rule.weekday]} of every month ${at}`;
    }
    return `Once on ${rule.date} ${at}`;
  }

  /**
   * Monday-based week index of a civil date, for INTERVAL on weekly rules.
   * @param {number} y
   * @param {number} m
   * @param {number} d
   */
  function weekIndex(y, m, d) {
    const days = Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
    return Math.floor((days + 3) / 7);
  }

  /**
   * Next occurrences at or after fromMs, oldest first. Searches at most five years ahead.
   * @param {any} input
   * @param {number} fromMs
   * @param {number} [count]
   * @returns {number[]}
   */
  function nextRuns(input, fromMs, count = 6) {
    const checked = normalizeRule(input);
    if (!checked.ok) return [];
    const rule = checked.rule;
    const start = /** @type {{ y: number, m: number, d: number }} */ (parseDate(rule.start_date));
    const startMs = zonedToUtc(start.y, start.m, start.d, rule.hour, rule.minute, rule.tz);
    const floor = Math.max(fromMs, rule.kind === 'once' ? -Infinity : startMs);
    /** @type {number[]} */
    const out = [];
    /**
     * @param {number} y
     * @param {number} m
     * @param {number} d
     */
    const consider = (y, m, d) => {
      const at = zonedToUtc(y, m, d, rule.hour, rule.minute, rule.tz);
      if (at >= floor) out.push(at);
    };
    if (rule.kind === 'once') {
      const day = /** @type {{ y: number, m: number, d: number }} */ (parseDate(rule.date));
      consider(day.y, day.m, day.d);
      return out.slice(0, count);
    }
    const from = localParts(floor, rule.tz);
    if (rule.kind === 'weekly') {
      const startWeek = weekIndex(start.y, start.m, start.d);
      let cursor = Date.UTC(from.y, from.m - 1, from.d);
      for (let i = 0; i < 5 * 366 && out.length < count; i += 1, cursor += DAY_MS) {
        const t = new Date(cursor);
        const y = t.getUTCFullYear();
        const m = t.getUTCMonth() + 1;
        const d = t.getUTCDate();
        if (!rule.weekdays.includes(dowOf(y, m, d))) continue;
        if ((weekIndex(y, m, d) - startWeek) % rule.interval !== 0) continue;
        consider(y, m, d);
      }
      return out;
    }
    const nth = rule.kind === 'monthly_last' ? -1 : rule.nth;
    let y = from.y;
    let m = from.m;
    for (let i = 0; i < 60 && out.length < count; i += 1) {
      const d = nthWeekday(y, m, rule.weekday, nth);
      if (d !== null) consider(y, m, d);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }

  /**
   * The occurrence in (nowMs - toleranceMs, nowMs], or null. A trigger hook uses this to decide if it is due.
   * @param {any} rule
   * @param {number} nowMs
   * @param {number} toleranceMs
   */
  function dueOccurrence(rule, nowMs, toleranceMs) {
    const [first] = nextRuns(rule, nowMs - toleranceMs + 1, 1);
    if (first === undefined || first > nowMs) return null;
    return first;
  }

  /**
   * Local wall-clock text for an instant, e.g. "Thu 2026-11-26 12:00".
   * @param {number} ms
   * @param {string} tz
   */
  function formatLocal(ms, tz) {
    const p = localParts(ms, tz);
    return `${DAY_NAMES[p.dow].slice(0, 3)} ${p.y}-${pad(p.m)}-${pad(p.d)} ${clock(p.h, p.mi)}`;
  }

  /**
   * @param {number} ms
   */
  function formatUtc(ms) {
    const t = new Date(ms);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${clock(t.getUTCHours(), t.getUTCMinutes())} UTC`;
  }

  return {
    DAY_CODES,
    DAY_NAMES,
    KINDS,
    defaultRule,
    normalizeRule,
    toRrule,
    parseRrule,
    describe,
    nextRuns,
    dueOccurrence,
    localParts,
    zonedToUtc,
    nthWeekday,
    validTimezone,
    formatLocal,
    formatUtc,
  };
});
