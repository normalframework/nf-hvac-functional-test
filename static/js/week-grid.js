// BAS-style weekly grid: 7 days x 24 h, 15 minute snap. Drag on a lane to paint a test window, drag a
// window to move it, drag its edges to resize, double-click or Delete to remove. Read-only overlays:
// occupied hours from the NF schedule, special events for the shown week, scheduled runs, and now.
// Browser global NfftWeekGrid.
(function (root) {
  'use strict';

  const D = () => /** @type {any} */ (root).NfftDom;
  const SNAP = 15;
  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /**
   * @param {number} minute
   */
  function hhmm(minute) {
    const m = Math.max(0, Math.min(1440, minute));
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  /**
   * @param {HTMLElement} host
   * @param {{ onChange: (windows: any[]) => void }} options
   */
  function mount(host, options) {
    const d = D();
    /** @type {{ start: number, end: number }[][]} */
    let windows = [[], [], [], [], [], [], []];
    /** @type {any} */
    let last = null;
    /** @type {null | { day: number, index: number, mode: string, origin: number, startMin: number, endMin: number, lane: HTMLElement }} */
    let drag = null;

    /**
     * @param {HTMLElement} lane
     * @param {PointerEvent} event
     */
    const minuteAt = (lane, event) => {
      const box = lane.getBoundingClientRect();
      const frac = (event.clientX - box.left) / box.width;
      return Math.max(0, Math.min(1440, Math.round((frac * 1440) / SNAP) * SNAP));
    };

    /**
     * @param {HTMLElement} node
     * @param {number} start
     * @param {number} end
     */
    const place = (node, start, end) => {
      node.style.left = `${(start / 1440) * 100}%`;
      node.style.width = `${(Math.max(end - start, 0) / 1440) * 100}%`;
    };

    const commit = () => {
      options.onChange(windows.map((day) => day.map((b) => ({ ...b }))));
    };

    /**
     * @param {any} state
     */
    function render(state) {
      last = state;
      windows = (state.windows || []).map((/** @type {any[]} */ day) => day.map((b) => ({ ...b })));
      while (windows.length < 7) windows.push([]);
      const head = d.el('div', { class: 'week-head' }, d.el('div'),
        d.el('div', { class: 'week-hours' }, ...Array.from({ length: 24 }, (_, h) => d.el('span', { text: h % 3 === 0 ? `${String(h).padStart(2, '0')}:00` : '' }))));
      const rows = state.days.map((/** @type {any} */ day, /** @type {number} */ i) => {
        const lane = d.el('div', { class: `week-lane${day.events.length ? ' event' : ''}`, dataset: { day: String(i) }, 'aria-label': `${DAY_LABELS[i]} ${day.label}` });
        if (day.events.length) lane.appendChild(d.el('div', { class: 'week-eventfill' }));
        for (const occ of state.occupied[i] || []) {
          const o = d.el('div', { class: 'week-occ', title: `Occupied ${hhmm(occ.start)}-${hhmm(occ.end)} (NF schedule)` });
          place(o, occ.start, occ.end);
          lane.appendChild(o);
        }
        windows[i].forEach((b, index) => {
          const block = d.el('div', { class: 'week-block', tabindex: '0', title: `Test window ${hhmm(b.start)}-${hhmm(b.end)}`, dataset: { index: String(index) } },
            d.el('span', { class: 'h l', dataset: { edge: 'l' } }), `${hhmm(b.start)}–${hhmm(b.end)}`, d.el('span', { class: 'h r', dataset: { edge: 'r' } }));
          place(block, b.start, b.end);
          block.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            windows[i].splice(index, 1);
            commit();
          });
          block.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
              windows[i].splice(index, 1);
              commit();
            }
          });
          lane.appendChild(block);
        });
        for (const run of day.runs) {
          const mark = d.el('div', { class: `week-run${run.runs ? '' : ' skip'}`, title: `${run.local} (${run.utc})${run.reason ? ` · skipped: ${run.reason}` : ' · will run'}` });
          mark.style.left = `${(run.minute / 1440) * 100}%`;
          lane.appendChild(mark);
        }
        if (day.nowMinute !== null) {
          const now = d.el('div', { class: 'week-now', title: 'Now' });
          now.style.left = `${(day.nowMinute / 1440) * 100}%`;
          lane.appendChild(now);
        }
        lane.addEventListener('pointerdown', (event) => begin(event, lane, i));
        const label = d.el('div', { class: `week-day${day.today ? ' today' : ''}` }, d.el('b', { text: DAY_LABELS[i] }), d.el('span', { text: day.label }),
          ...day.events.map((/** @type {string} */ name) => d.el('span', { class: 'ev', text: name })));
        return d.el('div', { class: 'week-row' }, label, lane);
      });
      d.fill(host, head, ...rows);
    }

    /**
     * @param {PointerEvent} event
     * @param {HTMLElement} lane
     * @param {number} day
     */
    function begin(event, lane, day) {
      if (event.button !== 0) return;
      const target = /** @type {HTMLElement} */ (event.target);
      const blockNode = /** @type {HTMLElement | null} */ (target.closest('.week-block'));
      const at = minuteAt(lane, event);
      if (blockNode) {
        const index = Number(blockNode.dataset.index);
        const b = windows[day][index];
        const edge = target.dataset.edge;
        drag = { day, index, mode: edge === 'l' ? 'left' : edge === 'r' ? 'right' : 'move', origin: at, startMin: b.start, endMin: b.end, lane };
        blockNode.classList.add('drag');
      } else {
        windows[day].push({ start: at, end: Math.min(1440, at + SNAP) });
        drag = { day, index: windows[day].length - 1, mode: 'right', origin: at, startMin: at, endMin: Math.min(1440, at + SNAP), lane };
        render({ ...last, windows });
        lane = /** @type {HTMLElement} */ (host.querySelector(`.week-lane[data-day="${day}"]`));
        drag.lane = lane;
      }
      lane.setPointerCapture(event.pointerId);
      lane.addEventListener('pointermove', move);
      lane.addEventListener('pointerup', end, { once: true });
      lane.addEventListener('pointercancel', end, { once: true });
      event.preventDefault();
    }

    /**
     * @param {PointerEvent} event
     */
    function move(event) {
      if (!drag) return;
      const lane = /** @type {HTMLElement} */ (host.querySelector(`.week-lane[data-day="${drag.day}"]`));
      const at = minuteAt(lane, event);
      const b = windows[drag.day][drag.index];
      if (!b) return;
      if (drag.mode === 'move') {
        const span = drag.endMin - drag.startMin;
        const start = Math.max(0, Math.min(1440 - span, drag.startMin + (at - drag.origin)));
        b.start = start;
        b.end = start + span;
      } else if (drag.mode === 'left') {
        b.start = Math.min(at, b.end - SNAP);
      } else {
        const anchor = drag.startMin;
        if (at >= anchor + SNAP) {
          b.start = anchor;
          b.end = at;
        } else if (at <= anchor - SNAP) {
          b.start = at;
          b.end = anchor;
        }
      }
      const node = /** @type {HTMLElement | null} */ (lane.querySelector(`.week-block[data-index="${drag.index}"]`));
      if (node) {
        place(node, b.start, b.end);
        node.childNodes[1].textContent = `${hhmm(b.start)}–${hhmm(b.end)}`;
      }
    }

    function end() {
      if (!drag) return;
      drag.lane.removeEventListener('pointermove', move);
      drag = null;
      commit();
    }

    return { render };
  }

  root.NfftWeekGrid = { mount, hhmm };
})(globalThis);
