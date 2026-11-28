// Schedule tab: recurrence builder, trigger mode (disabled / dry run / armed), next runs, weekly test windows,
// and the NF schedule blackout. Edits stay in a draft until Save. Browser global NfftScheduleView.
(function (root) {
  'use strict';

  const D = () => /** @type {any} */ (root).NfftDom;
  const R = () => /** @type {any} */ (root).NfftRrule;
  const T = () => /** @type {any} */ (root).NfftTimetable;
  const Tr = () => /** @type {any} */ (root).NfftTrigger;
  const DAY_MS = 86400000;
  const KIND_LABELS = { weekly: 'Weekly', monthly_nth: 'Nth weekday', monthly_last: 'Last weekday', once: 'One-off' };
  /**
   * DTSTART:20260101T180000Z -> 2026-01-01 18:00 UTC
   * @param {string} line
   */
  function firstUtc(line) {
    const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(line || '');
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC` : line;
  }
  const NTH = [[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth']];

  /**
   * @param {any} ctx { api, onChange(doc), notify(text, bad) }
   */
  function mount(ctx) {
    const d = D();
    /** @type {any} */
    let saved = null;
    /** @type {any} */
    let draft = null;
    /** @type {any} */
    let schedule;
    /** @type {{ uuid: string, name: string }[]} */
    let scheduleList = [];
    let weekOffset = 0;
    /** @type {{ id: string, label: string }[]} */
    let systems = [];
    const grid = /** @type {any} */ (root).NfftWeekGrid.mount(/** @type {HTMLElement} */ (document.getElementById('weekGrid')), {
      onChange(/** @type {any} */ windows) {
        draft = { ...draft, windows: T().normalizeWindows(windows) };
        renderAll();
      },
    });

    const dirty = () => saved && draft && JSON.stringify([saved.rule, saved.windows, saved.blackout, saved.scope, saved.system_ids, saved.stagger_minutes, saved.roster]) !== JSON.stringify([draft.rule, draft.windows, draft.blackout, draft.scope, draft.system_ids, draft.stagger_minutes, draft.roster]);

    /**
     * @param {any} view admin trigger answer
     */
    function load(view) {
      saved = Tr().normalize(view.trigger);
      draft = JSON.parse(JSON.stringify(saved));
      ctx.onChange(saved, view);
      renderAll();
      loadSchedule();
    }

    async function loadSchedule() {
      const uuid = draft && draft.blackout.schedule_uuid;
      if (!uuid) {
        schedule = undefined;
        renderAll();
        return;
      }
      try {
        schedule = T().normalizeSchedule(await ctx.api.schedule(uuid));
      } catch {
        schedule = null;
      }
      renderAll();
    }

    async function loadScheduleList() {
      try {
        scheduleList = await ctx.api.schedules();
      } catch {
        scheduleList = [];
      }
      renderBlackout();
    }

    /**
     * @param {any} patch
     */
    function setRule(patch) {
      const next = { ...draft.rule, ...patch };
      const checked = R().normalizeRule(next);
      draft = { ...draft, rule: checked.ok ? checked.rule : next };
      renderAll();
    }

    function timezones() {
      const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
      const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return [...new Set([draft.rule.tz, local, 'UTC', ...list])].filter(Boolean);
    }

    function renderBuilder() {
      const rule = draft.rule;
      const checked = R().normalizeRule(rule);
      const kinds = d.el('div', { class: 'seg flush' }, ...R().KINDS.map((/** @type {string} */ kind) => d.el('button', {
        type: 'button', class: rule.kind === kind ? 'on' : '', text: /** @type {any} */ (KIND_LABELS)[kind],
        onclick: () => {
          /** @type {any} */
          const patch = { kind };
          if (kind === 'weekly' && !Array.isArray(rule.weekdays)) Object.assign(patch, { weekdays: [3], interval: 1 });
          if ((kind === 'monthly_nth' || kind === 'monthly_last') && !Number.isInteger(rule.weekday)) patch.weekday = 3;
          if (kind === 'monthly_nth' && !Number.isInteger(rule.nth)) patch.nth = 1;
          if (kind === 'once' && !rule.date) patch.date = new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10);
          setRule(patch);
        },
      })));
      const weekdaySelect = () => d.el('select', { onchange: (/** @type {any} */ e) => setRule({ weekday: Number(e.target.value) }) },
        ...R().DAY_NAMES.map((/** @type {string} */ name, /** @type {number} */ i) => d.el('option', { value: String(i), text: name, selected: rule.weekday === i })));
      /** @type {any[]} */
      const rows = [d.el('label', { text: 'Repeats' }), kinds];
      if (rule.kind === 'weekly') {
        rows.push(d.el('label', { text: 'On' }), d.el('div', { class: 'daypick' }, ...R().DAY_NAMES.map((/** @type {string} */ name, /** @type {number} */ i) => d.el('button', {
          type: 'button', class: `btn${(rule.weekdays || []).includes(i) ? ' on' : ''}`, text: name.slice(0, 3),
          onclick: () => {
            const set = new Set(rule.weekdays || []);
            if (set.has(i)) set.delete(i);
            else set.add(i);
            setRule({ weekdays: [...set].sort() });
          },
        }))));
        rows.push(d.el('label', { text: 'Every' }), d.el('div', {}, d.el('input', { type: 'number', min: '1', max: '52', value: String(rule.interval || 1), onchange: (/** @type {any} */ e) => setRule({ interval: Number(e.target.value) }) }), ' week(s)'));
      }
      if (rule.kind === 'monthly_nth') {
        rows.push(d.el('label', { text: 'On the' }), d.el('div', {},
          d.el('select', { onchange: (/** @type {any} */ e) => setRule({ nth: Number(e.target.value) }) }, ...NTH.map(([n, label]) => d.el('option', { value: String(n), text: label, selected: rule.nth === n }))),
          ' ', weekdaySelect(), ' of the month'));
      }
      if (rule.kind === 'monthly_last') rows.push(d.el('label', { text: 'On the last' }), d.el('div', {}, weekdaySelect(), ' of the month'));
      if (rule.kind === 'once') rows.push(d.el('label', { text: 'Date' }), d.el('input', { type: 'date', value: rule.date || '', onchange: (/** @type {any} */ e) => setRule({ date: e.target.value }) }));
      rows.push(d.el('label', { text: 'At (site time)' }), d.el('input', {
        type: 'time', step: '900', value: `${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`,
        onchange: (/** @type {any} */ e) => {
          const [h, m] = String(e.target.value || '12:00').split(':').map(Number);
          setRule({ hour: h, minute: m });
        },
      }));
      rows.push(d.el('label', { text: 'Site timezone' }), d.el('select', { onchange: (/** @type {any} */ e) => setRule({ tz: e.target.value }) },
        ...timezones().map((tz) => d.el('option', { value: tz, text: tz, selected: tz === rule.tz }))));
      if (rule.kind !== 'once') rows.push(d.el('label', { text: 'Starting' }), d.el('input', { type: 'date', value: rule.start_date, onchange: (/** @type {any} */ e) => setRule({ start_date: e.target.value }) }));
      let words;
      let code;
      if (checked.ok) {
        const out = R().toRrule(checked.rule);
        words = d.el('div', { class: 'sentence' }, R().describe(checked.rule),
          d.el('small', { text: `Rule starts ${firstUtc(out.utc_dtstart)}. Daylight saving changes keep the site-local time.` }));
        code = d.el('div', {},
          d.el('div', { class: 'sub mt6', text: 'NF scheduled-hook RRULE for this rule (DTSTART on its own line). The shipped trigger hook runs every minute and checks this rule in the site timezone, so this text is for reference or for binding a hook to the rule directly.' }),
          d.el('pre', { class: 'rrule mono', text: out.text }));
      } else {
        words = d.el('div', { class: 'sentence bad', text: `Fix: ${/** @type {any} */ (checked).errors.join(', ')}` });
      }
      d.fill(document.getElementById('ruleBuilder'), d.el('div', { class: 'form-grid' }, ...rows), words, code);
    }

    function renderMode() {
      const mode = saved ? saved.mode : 'disabled';
      const opt = (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ text, /** @type {() => void} */ click) => d.el('button', {
        type: 'button', class: `mode-opt ${id === 'armed' ? 'armed' : id === 'dry_run' ? 'dry' : ''}${mode === id ? ' on' : ''}`, onclick: click,
      }, d.el('b', { text: title }), d.el('span', { text }));
      const armedNote = saved && saved.armed ? `Armed ${new Date(saved.armed.at).toLocaleString()}${saved.armed.by ? ` by ${saved.armed.by}` : ''}.` : '';
      d.fill(document.getElementById('modeControls'),
        d.el('div', { class: 'mode-seg' },
          opt('disabled', 'DISABLED', 'The schedule never starts a run.', () => change('disable')),
          opt('dry_run', 'DRY RUN', 'Scheduled rehearsal. Steps, timers and capture run; nothing is written.', () => change('dry_run')),
          opt('armed', 'ARMED', 'Scheduled live run. Needs confirmation.', () => openArm())),
        d.el('div', { class: 'mode-note', text: `${armedNote} Editing the rule, the windows or the blackout disarms back to dry run.` }));
    }

    function renderRuns() {
      const runs = Tr().preview(draft, Date.now(), schedule, 6);
      d.fill(document.getElementById('nextRuns'), runs.length ? d.el('div', { class: 'runs' }, ...runs.map((/** @type {any} */ run) => d.el('div', { class: `run-row${run.runs ? '' : ' skip'}` },
        d.el('i', { class: 'diamond' }),
        d.el('div', { class: 'when' }, d.el('b', { text: run.local }), d.el('span', { class: 'sub', text: run.utc })),
        d.el('span', { class: `chip ${run.runs ? 'go' : 'no'}`, text: run.runs ? (saved && saved.mode === 'armed' && !dirty() ? 'live run' : 'dry run') : `skip: ${run.reason}` })))) : d.el('p', { class: 'muted', text: 'No upcoming runs for this rule.' }));
    }

    function weekStart() {
      const tz = draft.rule.tz;
      const p = R().localParts(Date.now(), tz);
      const monday = Date.UTC(p.y, p.m - 1, p.d) - p.dow * DAY_MS + weekOffset * 7 * DAY_MS;
      return { monday, tz };
    }

    function renderWeek() {
      const { monday, tz } = weekStart();
      const now = Date.now();
      const todayParts = R().localParts(now, tz);
      const startUtc = R().zonedToUtc(new Date(monday).getUTCFullYear(), new Date(monday).getUTCMonth() + 1, new Date(monday).getUTCDate(), 0, 0, tz);
      const endUtc = startUtc + 7 * DAY_MS + 2 * 3600000;
      const runs = Tr().preview(draft, startUtc, schedule, 12).filter((/** @type {any} */ r) => r.at < endUtc);
      const days = Array.from({ length: 7 }, (_, i) => {
        const t = new Date(monday + i * DAY_MS);
        const day = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
        const events = schedule ? schedule.events.filter((/** @type {any} */ e) => T().eventMatches(e, day)).map((/** @type {any} */ e) => e.name) : [];
        const dayRuns = runs.filter((/** @type {any} */ r) => {
          const p = R().localParts(r.at, tz);
          return p.y === day.y && p.m === day.m && p.d === day.d;
        }).map((/** @type {any} */ r) => {
          const p = R().localParts(r.at, tz);
          return { ...r, minute: p.h * 60 + p.mi };
        });
        const today = todayParts.y === day.y && todayParts.m === day.m && todayParts.d === day.d;
        return {
          label: `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`,
          events,
          runs: dayRuns,
          today,
          nowMinute: today ? todayParts.h * 60 + todayParts.mi : null,
        };
      });
      const occupied = schedule ? T().occupiedBlocks(schedule) : [[], [], [], [], [], [], []];
      grid.render({ windows: draft.windows, days, occupied });
    }

    function renderBlackout() {
      if (!draft) return;
      const b = draft.blackout;
      const options = [{ uuid: '', name: 'None (no blackout)' }, ...scheduleList];
      if (b.schedule_uuid && !options.some((o) => o.uuid === b.schedule_uuid)) options.push({ uuid: b.schedule_uuid, name: b.schedule_uuid });
      const setB = (/** @type {any} */ patch) => {
        draft = { ...draft, blackout: { ...draft.blackout, ...patch } };
        renderAll();
        if (patch.schedule_uuid !== undefined) loadSchedule();
      };
      let status = 'No blackout schedule. Test windows alone decide.';
      if (b.schedule_uuid) {
        status = schedule === undefined ? 'Loading schedule...' : schedule === null
          ? 'Could not read this schedule. Runs are skipped until it can be read (fail closed).'
          : `${schedule.name || 'Schedule'}: ${schedule.events.length} special event(s). Evaluated in ${draft.rule.tz}.`;
      }
      d.fill(document.getElementById('blackout'), d.el('div', { class: 'form-grid' },
        d.el('label', { text: 'NF schedule' }),
        d.el('select', { onchange: (/** @type {any} */ e) => setB({ schedule_uuid: e.target.value }) }, ...options.map((o) => d.el('option', { value: o.uuid, text: o.name, selected: o.uuid === b.schedule_uuid }))),
        d.el('label', { text: 'Skip a run when' }),
        d.el('div', {},
          d.el('label', {}, d.el('input', { type: 'checkbox', checked: b.block_when_occupied, onchange: (/** @type {any} */ e) => setB({ block_when_occupied: e.target.checked }) }), ' the schedule says occupied'), d.el('br'),
          d.el('label', {}, d.el('input', { type: 'checkbox', checked: b.block_on_special_event, onchange: (/** @type {any} */ e) => setB({ block_on_special_event: e.target.checked }) }), ' a special event (holiday) matches the day'))),
      d.el('p', { class: `sub${schedule === null && b.schedule_uuid ? ' bad' : ''}`, text: status }));
    }

    function renderScope() {
      const host = document.getElementById('scheduleScope');
      if (!host || !draft) return;
      const d = D();
      const siteWide = draft.scope !== 'systems';
      const selected = new Set(draft.system_ids || []);
      const set = (/** @type {any} */ patch) => {
        draft = { ...draft, ...patch };
        renderAll();
      };
      const toggle = (/** @type {string} */ id, /** @type {boolean} */ on) => {
        const ids = (draft.system_ids || []).filter((/** @type {string} */ x) => x !== id);
        if (on) ids.push(id);
        set({ system_ids: ids });
      };
      const rosterIds = systems.map((s) => s.id);
      const hint = siteWide
        ? (systems.length
          ? `Every air handler in the model (${systems.map((s) => s.label).join(', ') || systems.length}).`
          : 'Every air handler in the model. The graphic tab fills this list once the model loads.')
        : (draft.system_ids.length
          ? `${draft.system_ids.length} system${draft.system_ids.length === 1 ? '' : 's'} selected.`
          : 'No systems selected — a due occurrence will start nothing.');
      const staggerHelp = (Number(draft.stagger_minutes) || 0) > 0
        ? `Later systems start ${draft.stagger_minutes} minute${draft.stagger_minutes === 1 ? '' : 's'} after the previous.`
        : 'Systems are queued at the same occurrence. The runner starts the next when the previous run has finished.';
      const list = systems.length
        ? d.el('div', { class: 'scope-list' }, ...systems.map((s) => d.el('label', { class: 'scope-item' },
          d.el('input', {
            type: 'checkbox',
            checked: siteWide ? true : selected.has(s.id),
            disabled: siteWide,
            onchange: (/** @type {any} */ e) => toggle(s.id, e.target.checked),
          }),
          ` ${s.label}`)))
        : d.el('p', { class: 'muted', text: 'No air handlers loaded yet. Open the Functional test graphic tab, or wait for the model.' });
      d.fill(host,
        d.el('div', { class: 'form-grid' },
          d.el('label', { text: 'Coverage' }),
          d.el('div', { class: 'seg' },
            d.el('button', { type: 'button', class: siteWide ? 'on' : '', onclick: () => set({ scope: 'all', roster: rosterIds }), text: 'Site-wide' }),
            d.el('button', { type: 'button', class: !siteWide ? 'on' : '', onclick: () => set({ scope: 'systems', roster: rosterIds }), text: 'Selected systems' })),
          d.el('label', { text: 'Air handlers' }),
          list,
          d.el('label', { text: 'Start' }),
          d.el('div', {},
            d.el('label', {}, 'Stagger later systems by ',
              d.el('input', {
                type: 'number',
                min: '0',
                step: '1',
                value: String(draft.stagger_minutes || 0),
                onchange: (/** @type {any} */ e) => set({ stagger_minutes: Math.max(0, Number(e.target.value) || 0) }),
                class: 'stagger-input',
              }),
              ' minutes (0 = together)')),
          d.el('p', { class: 'sub', text: `${hint} ${staggerHelp}` })));
    }

    function renderSaveBar() {
      const state = document.getElementById('saveState');
      if (!state) return;
      const isDirty = dirty();
      state.textContent = isDirty ? `Unsaved changes${saved && saved.mode === 'armed' ? ' (saving disarms to dry run)' : ''}` : 'No unsaved changes';
      state.className = isDirty ? 'dirty' : 'muted';
      /** @type {HTMLButtonElement} */ (document.getElementById('saveBtn')).disabled = !isDirty || !R().normalizeRule(draft.rule).ok;
      /** @type {HTMLButtonElement} */ (document.getElementById('revertBtn')).disabled = !isDirty;
    }

    function renderAll() {
      if (!draft) return;
      renderBuilder();
      renderMode();
      renderRuns();
      renderWeek();
      renderBlackout();
      renderScope();
      renderSaveBar();
    }

    /**
     * @param {string} op
     * @param {any} [payload]
     */
    async function change(op, payload) {
      try {
        const view = await ctx.api.trigger(op, payload);
        if (!view.ok) {
          ctx.notify(`Not changed: ${view.code}${view.errors ? ` (${view.errors.join(', ')})` : ''}`, true);
          return;
        }
        load(view);
        if (view.note === 'disarmed_on_change') ctx.notify('Saved. The change disarmed live runs; the trigger is back to dry run.', false);
      } catch (error) {
        ctx.notify(`Could not reach the admin hook: ${/** @type {any} */ (error).message}`, true);
      }
    }

    function openArm() {
      if (dirty()) {
        ctx.notify('Save or revert the schedule before arming.', true);
        return;
      }
      const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('armDialog'));
      const ack = /** @type {HTMLInputElement} */ (document.getElementById('armAck'));
      const phrase = /** @type {HTMLInputElement} */ (document.getElementById('armPhrase'));
      const confirm = /** @type {HTMLButtonElement} */ (document.getElementById('armConfirm'));
      ack.checked = false;
      phrase.value = '';
      confirm.disabled = true;
      const check = () => { confirm.disabled = !(ack.checked && phrase.value.trim() === Tr().ARM_PHRASE); };
      ack.onchange = check;
      phrase.oninput = check;
      dialog.onclose = () => {
        if (dialog.returnValue === 'arm' && ack.checked && phrase.value.trim() === Tr().ARM_PHRASE) {
          change('arm', { confirm: true, phrase: phrase.value.trim(), by: 'operator' });
        }
      };
      dialog.showModal();
    }

    /** @type {HTMLElement} */ (document.getElementById('saveBtn')).addEventListener('click', () => change('save', {
      rule: draft.rule,
      windows: draft.windows,
      blackout: draft.blackout,
      scope: draft.scope,
      system_ids: draft.system_ids,
      stagger_minutes: draft.stagger_minutes,
      roster: systems.map((s) => s.id),
    }));
    /** @type {HTMLElement} */ (document.getElementById('revertBtn')).addEventListener('click', () => {
      draft = JSON.parse(JSON.stringify(saved));
      renderAll();
      loadSchedule();
    });
    /** @type {HTMLElement} */ (document.getElementById('weekPrev')).addEventListener('click', () => { weekOffset -= 1; renderWeek(); });
    /** @type {HTMLElement} */ (document.getElementById('weekNext')).addEventListener('click', () => { weekOffset += 1; renderWeek(); });
    /** @type {HTMLElement} */ (document.getElementById('weekNow')).addEventListener('click', () => { weekOffset = 0; renderWeek(); });

    loadScheduleList();
    return {
      load,
      refresh: () => draft && renderRuns(),
      setWeekOffset(/** @type {number} */ n) { weekOffset = n; renderWeek(); },
      setSystems(/** @type {{ id: string, label: string }[]} */ list) {
        systems = Array.isArray(list) ? list.filter((s) => s && s.id) : [];
        if (draft && draft.scope !== 'systems') draft = { ...draft, roster: systems.map((s) => s.id) };
        if (draft) renderScope();
      },
      schedule: () => schedule,
    };
  }

  root.NfftScheduleView = { mount };
})(globalThis);
