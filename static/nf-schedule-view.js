// Schedule tab, top panel: the building's own NF schedules (NF schedule service, /api/v1/schedules), drawn as a weekly
// grid in the same layout as NF's editor (Mon to Sun columns, periods as blocks). Read only: edits happen in NF's own
// graphical editor (Schedules page), which this panel links to. The functional test windows below are this app's
// own and are kept separate from building occupancy. Browser global NfftNfScheduleView; blocksOf for Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else /** @type {any} */ (root).NfftNfScheduleView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const g = /** @type {any} */ (typeof globalThis !== 'undefined' ? globalThis : {});

  /** "off" for a schedule value: null, false, 0. Anything else is a period worth drawing. @param {any} v */
  const isOff = (v) => v === null || v === undefined || v === false || v === 0 || v === 'false' || v === 'inactive';

  /**
   * Periods per day from a normalized weekly schedule (NfftTimetable.normalizeSchedule().weekly): each transition holds
   * until the next one, the last one until midnight. Periods with an "off" value are dropped.
   * @param {{ min: number, value: any }[][]} weekly
   * @param {any} [defaultValue] value before the first transition of the day
   */
  function blocksOf(weekly, defaultValue) {
    return DAYS.map((_, i) => {
      const day = (weekly && weekly[i]) || [];
      /** @type {{ start: number, end: number, value: any }[]} */
      const out = [];
      if (day.length && day[0].min > 0 && !isOff(defaultValue)) out.push({ start: 0, end: day[0].min, value: defaultValue });
      day.forEach((tv, j) => {
        const end = j + 1 < day.length ? day[j + 1].min : 1440;
        if (end > tv.min && !isOff(tv.value)) out.push({ start: tv.min, end, value: tv.value });
      });
      if (!day.length && !isOff(defaultValue)) out.push({ start: 0, end: 1440, value: defaultValue });
      return out;
    });
  }

  const hhmm = (/** @type {number} */ m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const valueText = (/** @type {any} */ v) => (v === true || v === 1 ? 'On' : v === false || v === 0 ? 'Off' : String(v));

  /**
   * @param {{ api: any, host: HTMLElement, notify: (t: string, bad?: boolean) => void, consoleUrl?: string }} o
   */
  function mount(o) {
    const d = g.NfftDom;
    const T = g.NfftTimetable;
    /** @type {{ uuid: string, name: string }[]} */
    let list = [];
    /** @type {any} */
    let raw = null;
    /** @type {any} */
    let sched = null;
    let pick = '';
    let error = '';
    let loaded = false;

    async function load() {
      try {
        list = await o.api.schedules();
        if (!pick || !list.some((s) => s.uuid === pick)) pick = list.length ? list[0].uuid : '';
        raw = pick ? await o.api.schedule(pick) : null;
        sched = raw ? T.normalizeSchedule(raw) : null;
        error = '';
      } catch (err) {
        error = String(/** @type {any} */ (err).message || err);
      }
      loaded = true;
      render();
    }

    function grid() {
      const blocks = blocksOf(sched.weekly, sched.defaultValue);
      const hours = [];
      for (let h = 0; h < 24; h += 2) hours.push(d.el('div', { class: 'nfs-hour', text: `${String(h).padStart(2, '0')}:00` }));
      const now = new Date();
      const today = (now.getDay() + 6) % 7;
      const nowMin = now.getHours() * 60 + now.getMinutes();
      return d.el('div', { class: 'nfs-grid' },
        d.el('div', { class: 'nfs-col nfs-times' }, d.el('div', { class: 'nfs-head', text: 'Time' }), d.el('div', { class: 'nfs-body' }, ...hours)),
        ...DAYS.map((name, i) => {
          const body = d.el('div', { class: 'nfs-body' });
          for (const b of blocks[i]) {
            const el = d.el('div', { class: 'nfs-block', title: `${name} ${hhmm(b.start)} – ${hhmm(b.end)}: ${valueText(b.value)}` },
              d.el('b', { text: `${hhmm(b.start)} – ${hhmm(b.end === 1440 ? 1440 : b.end)}` }), d.el('span', { text: valueText(b.value) }));
            el.style.top = `${(b.start / 1440) * 100}%`;
            el.style.height = `${((b.end - b.start) / 1440) * 100}%`;
            body.appendChild(el);
          }
          if (i === today) {
            const line = d.el('div', { class: 'nfs-now', title: 'now (browser time)' });
            line.style.top = `${(nowMin / 1440) * 100}%`;
            body.appendChild(line);
          }
          return d.el('div', { class: `nfs-col${i === today ? ' today' : ''}` }, d.el('div', { class: 'nfs-head', text: name }), body);
        }));
    }

    function render() {
      const host = o.host;
      if (!host) return;
      const editor = d.el('a', { class: 'btn primary', href: `${o.consoleUrl || ''}/schedules`, target: '_blank', rel: 'noopener', text: 'Edit in NF Schedules ↗' });
      const head = d.el('h2', {}, 'Building occupancy',
        d.el('span', { class: 'hint', text: 'NF schedule service · read only here · edit periods, exceptions and targets in NF\'s own editor' }),
        list.length > 1 ? d.el('select', { 'aria-label': 'NF schedule', onchange: (/** @type {any} */ e) => { pick = e.target.value; load(); } },
          ...list.map((s) => d.el('option', { value: s.uuid, text: s.name, selected: s.uuid === pick }))) : null,
        editor);
      if (!loaded) { d.fill(host, head, d.el('p', { class: 'muted', text: 'Reading NF schedules…' })); return; }
      if (error) { d.fill(host, head, d.el('p', { class: 'banner bad-banner', text: `Cannot read NF schedules: ${error}` })); return; }
      if (!sched) {
        d.fill(host, head, d.el('p', { class: 'muted', text: 'This NF has no schedules yet. Create the building occupancy schedule on NF\'s Schedules page (Create Schedule, then drag periods on the Weekly tab). It shows here, and the test windows below can avoid it.' }));
        return;
      }
      const body = raw && raw.schedule ? raw.schedule : raw || {};
      const src = body.source || {};
      const pv = body.presentValue || body.present_value;
      const targets = (body.targets || []).length;
      const events = sched.events || [];
      d.fill(host, head,
        d.el('div', { class: 'nfs-meta' },
          d.el('span', { class: 'pill', text: sched.name }),
          d.el('span', { class: 'pill', text: `source ${String(src.type || 'LOCAL').toLowerCase()}${src.syncMode && src.syncMode !== 'SYNC_NONE' ? ` · ${String(src.syncMode).replace('SYNC_', '').toLowerCase()} sync` : ''}` }),
          d.el('span', { class: 'pill', text: `now ${pv ? valueText(T.scalar ? T.scalar(pv) : (pv.boolean ?? pv.real ?? pv.unsigned)) : '—'}` }),
          d.el('span', { class: 'pill', text: `default ${valueText(sched.defaultValue)}` }),
          d.el('span', { class: 'pill', text: `${targets} write target${targets === 1 ? '' : 's'}` }),
          sched.outOfService ? d.el('span', { class: 'pill op-warn', text: 'out of service' }) : null),
        grid(),
        d.el('div', { class: 'nfs-events' }, d.el('b', { text: `Exceptions (${events.length})` }),
          events.length ? d.el('ul', {}, ...events.map((/** @type {any} */ e) => d.el('li', { text: `${e.name || 'event'} · priority ${e.priority ?? '—'} · ${e.date ? `${e.date.y ?? '*'}-${e.date.m ?? '*'}-${e.date.d ?? '*'}` : e.range ? 'date range' : 'pattern'}` })))
            : d.el('span', { class: 'muted', text: ' none' })));
    }

    return { load, render, current: () => sched };
  }

  return { mount, blocksOf, DAYS };
});
