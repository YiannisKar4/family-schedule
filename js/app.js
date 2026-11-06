// Family schedule: week and month calendar, quick add, weekly series.
import * as supa from './supa.js?v=1';
import * as api from './api.js?v=1';
import { ApiError } from './api.js?v=1';
import { STORAGE_PREFIX } from './config.js?v=1';
import {
  today, addDays, addMonths, weekStart, monthGrid, weekday, minutes, pad, diffDays,
  expand, lanes, DAY_SHORT, DAY_LETTER, DAY_LONG, monthName, longDate, shortDate, rangeLabel,
} from './dates.js?v=1';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CACHE_KEY = `${STORAGE_PREFIX}.cache`;
const PREFS_KEY = `${STORAGE_PREFIX}.prefs`;
const LOGIN_EMAIL_KEY = `${STORAGE_PREFIX}.loginEmail`;
const VIEWS = ['week', 'month'];
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#00a3b4', '#52514e'];
const HOUR_PX = 44;
const wide = () => matchMedia('(min-width: 700px)').matches;

const state = {
  view: 'week',
  anchor: today(),
  data: null, // { members, categories, events, titles, from, to }
  filter: [], // member ids; empty = everyone
  loading: false,
  lastFetch: 0,
  editing: null, // { event, date } while the event window is open
};

/* ------------------------------------------------------------- storage */

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
function savePrefs() {
  saveJson(PREFS_KEY, { view: state.view, filter: state.filter });
}

/* --------------------------------------------------------------- toast */

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.className = `toast${isError ? ' error' : ''}`;
  t.innerHTML = `<span class="toast-icon">${isError
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'}</span>
    <span class="toast-msg"></span>
    <button type="button" class="toast-x" aria-label="Κλείσιμο"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
  $('.toast-msg', t).textContent = msg;
  $('.toast-x', t).addEventListener('click', hideToast);
  t.hidden = false;
  try { if (t.showPopover && !t.matches(':popover-open')) t.showPopover(); } catch { /* not supported */ }
  requestAnimationFrame(() => t.classList.add('in'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, isError ? 6000 : 2600);
}
function hideToast() {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.classList.remove('in');
  toastTimer = setTimeout(() => {
    t.hidden = true;
    try { if (t.hidePopover && t.matches(':popover-open')) t.hidePopover(); } catch { /* not supported */ }
  }, 200);
}

/** A small window with buttons. Resolves with the value of the button pressed, or '' (Esc, Άκυρο). */
function ask({ title, text = '', buttons }) {
  const dlg = $('#ask-dlg');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = text;
  $('#ask-text').hidden = !text;
  $('#ask-actions').innerHTML = buttons.map((b) =>
    `<button class="btn${b.primary ? ' primary' : ''}${b.danger ? ' primary danger-fill' : ''}" value="${esc(b.value)}">${esc(b.label)}</button>`).join('');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('.btn.primary')?.focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
}

/* ---------------------------------------------------------------- data */

function neededRange() {
  if (state.view === 'week') {
    const f = weekStart(state.anchor);
    return [f, addDays(f, 6)];
  }
  const g = monthGrid(state.anchor);
  return [g[0], g[41]];
}

/** Loads about three months around what is on screen. */
async function fetchData({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  $('#refresh').classList.add('spin');
  const from = monthGrid(addMonths(state.anchor, -1))[0];
  const to = monthGrid(addMonths(state.anchor, 1))[41];
  try {
    const body = await api.read(from, to);
    state.data = { members: body.members, categories: body.categories, events: body.events, titles: body.titles, from, to };
    state.lastFetch = Date.now();
    saveJson(CACHE_KEY, state.data);
    render();
  } catch (err) {
    if (handleAuthError(err)) return;
    if (!quiet || !state.data) toast(err.message, true);
    if (!state.data) render();
  } finally {
    state.loading = false;
    $('#refresh').classList.remove('spin');
  }
}

/** Shows the new dates, and loads more when they are outside what is loaded. */
function show() {
  render();
  const [f, t] = neededRange();
  if (!state.data || f < state.data.from || t > state.data.to) fetchData();
}

function handleAuthError(err) {
  if (!(err instanceof ApiError) || !['login-required', 'no-access'].includes(err.code)) return false;
  if (err.code === 'no-access') supa.signOut();
  forgetData();
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  render();
  toast(err.message, true);
  return true;
}

function forgetData() {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
  state.data = null;
}

const memberById = (id) => state.data.members.find((m) => m.id === id);
const categoryById = (id) => state.data.categories.find((c) => c.id === id);

function colorOf(ev) {
  const c = ev.category && categoryById(ev.category);
  if (c) return c.color;
  const m = ev.members.length && memberById(ev.members[0]);
  return m ? m.color : 'var(--accent)';
}

function visible(ev) {
  if (!state.filter.length || !ev.members.length) return true;
  return ev.members.some((id) => state.filter.includes(id));
}

function occurrences(from, to) {
  return expand(state.data.events, from, to).filter((o) => visible(o.event));
}

const timeText = (o) => (o.allDay ? 'Όλη μέρα' : `${o.start}–${o.end}`);
const membersText = (ev) => ev.members.map((id) => memberById(id)?.name).filter(Boolean).join(', ');
const dots = (ev) => ev.members.map((id) => {
  const m = memberById(id);
  return m ? `<i class="dot" style="background:${m.color}" title="${esc(m.name)}"></i>` : '';
}).join('');

/* -------------------------------------------------------------- render */

function render() {
  const ready = supa.signedIn() && state.data;
  $('#tabs-wrap').hidden = !ready;
  $('#range-nav').hidden = !ready;
  $('#today').hidden = !ready;
  $('#fab').hidden = !ready;
  $('#open-settings').hidden = !supa.signedIn();
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === state.view)));
  if (!supa.signedIn()) return renderLogin();
  if (!state.data) {
    $('#main').innerHTML = '<div class="empty">Φόρτωση…</div>';
    return;
  }
  renderFilter();
  if (state.view === 'month') renderMonth();
  else renderWeek();
}

function renderFilter() {
  const members = state.data.members.filter((m) => !m.hidden);
  const box = $('#who-filter');
  box.hidden = members.length < 2;
  const all = !state.filter.length;
  box.innerHTML = `<button type="button" class="who${all ? ' on' : ''}" data-id="">Όλοι</button>${members.map((m) =>
    `<button type="button" class="who${state.filter.includes(m.id) ? ' on' : ''}" data-id="${m.id}" style="--c:${m.color}"><i class="dot" style="background:${m.color}"></i>${esc(m.name)}</button>`).join('')}`;
}

function renderWeek() {
  const from = weekStart(state.anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  $('#range-label').textContent = rangeLabel(days[0], days[6]);
  const occ = occurrences(days[0], days[6]);
  const t = today();

  const allDay = days.map((d) => occ.filter((o) => o.allDay && o.date <= d && o.endDate >= d));
  const timed = days.map((d) => lanes(occ.filter((o) => !o.allDay && o.date === d)));
  let startH = 7;
  let endH = 22;
  for (const list of timed) for (const o of list) {
    startH = Math.min(startH, Math.floor(minutes(o.start) / 60));
    endH = Math.max(endH, Math.ceil(minutes(o.end) / 60));
  }
  const hours = endH - startH;

  const head = days.map((d, i) => `<button type="button" class="wk-day${d === t ? ' today' : ''}" data-day="${d}">
      <span class="wd">${DAY_SHORT[i]}</span><span class="dn">${Number(d.slice(8))}</span></button>`).join('');
  const allDayRow = allDay.some((l) => l.length) ? `<div class="wk-allday"><div class="gutter small muted">όλη<br>μέρα</div>${allDay.map((list, i) =>
    `<div class="ad-cell">${list.map((o) => chip(o, days[i])).join('')}</div>`).join('')}</div>` : '';
  const gutter = Array.from({ length: hours }, (_, i) => `<div class="hr" style="top:${i * HOUR_PX}px">${pad(startH + i)}:00</div>`).join('');
  const cols = timed.map((list, i) => {
    const d = days[i];
    const blocks = list.map((o) => {
      const top = ((minutes(o.start) - startH * 60) / 60) * HOUR_PX;
      const h = Math.max(((minutes(o.end) - minutes(o.start)) / 60) * HOUR_PX, 22);
      const w = 100 / o.lanes;
      const short = h < 36;
      return `<button type="button" class="ev${short ? ' short' : ''}" data-id="${o.event.id}" data-date="${d}"
        style="top:${top}px;height:${h - 2}px;left:calc(${o.lane * w}% + 1px);width:calc(${w}% - 2px);--c:${colorOf(o.event)}">
        <span class="ev-t">${esc(o.event.title)}</span>${short ? '' : `<span class="ev-s">${o.start}${dots(o.event) ? ` ${dots(o.event)}` : ''}</span>`}</button>`;
    }).join('');
    let now = '';
    if (d === t) {
      const n = new Date();
      const m = n.getHours() * 60 + n.getMinutes() - startH * 60;
      if (m >= 0 && m <= hours * 60) now = `<div class="now" style="top:${(m / 60) * HOUR_PX}px"></div>`;
    }
    return `<div class="wk-col${d === t ? ' today' : ''}" data-day="${d}">${blocks}${now}</div>`;
  }).join('');

  const empty = !occ.length ? `<p class="empty small">Τίποτα αυτή την εβδομάδα. Πάτα σε μια ώρα ή στο «Νέο» για να προσθέσεις.</p>` : '';
  const noMembers = !state.data.members.length
    ? '<div class="note">Πρόσθεσε τα μέλη της οικογένειας από τις <b>Ρυθμίσεις</b> (γρανάζι πάνω δεξιά), για να ξέρεις ποιος έχει τι.</div>' : '';
  $('#main').innerHTML = `${noMembers}
    <div class="week card">
      <div class="wk-head"><div class="gutter"></div>${head}</div>
      ${allDayRow}
      <div class="wk-grid" style="height:${hours * HOUR_PX}px;--hour:${HOUR_PX}px" data-start="${startH}">
        <div class="gutter">${gutter}</div>${cols}
      </div>
    </div>${empty}`;
}

function chip(o, day) {
  const cont = o.date < day ? ' cont' : '';
  return `<button type="button" class="chip${cont}" data-id="${o.event.id}" data-date="${o.date}" style="--c:${colorOf(o.event)}">${o.allDay ? '' : `<b>${o.start}</b> `}${esc(o.event.title)}</button>`;
}

function renderMonth() {
  const grid = monthGrid(state.anchor);
  const m = state.anchor.slice(0, 7);
  $('#range-label').textContent = monthName(state.anchor);
  const occ = occurrences(grid[0], grid[41]);
  const t = today();
  // Drop the last week when it is wholly in the next month.
  const cells = grid[35].slice(0, 7) !== m ? grid.slice(0, 35) : grid;
  const max = wide() ? 4 : 3;
  $('#main').innerHTML = `<div class="month card">
    <div class="mo-head">${DAY_SHORT.map((d) => `<div>${d}</div>`).join('')}</div>
    <div class="mo-grid">${cells.map((d) => {
      const list = occ.filter((o) => o.date <= d && o.endDate >= d);
      const more = list.length - max;
      return `<div class="mo-cell${d.slice(0, 7) !== m ? ' out' : ''}${d === t ? ' today' : ''}" data-day="${d}" role="button" tabindex="0" aria-label="${esc(longDate(d))}, ${list.length} δραστηριότητες">
        <span class="mo-dn">${Number(d.slice(8))}</span>
        ${list.slice(0, more > 0 ? max - 1 : max).map((o) => chip(o, d)).join('')}
        ${more > 0 ? `<span class="more">+${more + 1}</span>` : ''}
      </div>`;
    }).join('')}</div>
  </div>`;
}

/* ----------------------------------------------------------- day window */

function openDay(d) {
  const list = occurrences(d, d);
  $('#day-title').textContent = longDate(d);
  $('#day-list').innerHTML = list.length ? list.map((o) => `
    <button type="button" class="ag-row" data-id="${o.event.id}" data-date="${o.date}" style="--c:${colorOf(o.event)}">
      <span class="ag-time">${o.allDay ? 'Όλη<br>μέρα' : `${o.start}<br><span class="muted">${o.end}</span>`}</span>
      <span class="ag-main"><b>${esc(o.event.title)}</b>
        <span class="small muted">${esc([membersText(o.event), o.event.location].filter(Boolean).join(' · '))}${o.series ? ' · ↻' : ''}</span></span>
    </button>`).join('') : '<p class="empty small">Τίποτα αυτή τη μέρα.</p>';
  const dlg = $('#day-dlg');
  dlg.dataset.day = d;
  dlg.showModal();
}

/* --------------------------------------------------------- event window */

const form = {
  get repeat() { return Number($('#f-repeat [aria-pressed="true"]').dataset.v); },
  set repeat(v) {
    $('#f-repeat').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === v)));
    $('#repeat-box').hidden = !v;
  },
  get days() { return [...$('#f-days').querySelectorAll('[aria-pressed="true"]')].map((b) => Number(b.dataset.v)); },
  set days(list) { $('#f-days').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(list.includes(Number(b.dataset.v))))); },
  get category() { return Number($('#f-category [aria-pressed="true"]')?.dataset.v) || null; },
  set category(id) { $('#f-category').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === id))); },
  get members() { return [...$('#f-members').querySelectorAll('[aria-pressed="true"]')].map((b) => Number(b.dataset.v)); },
  set members(list) { $('#f-members').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(list.includes(Number(b.dataset.v))))); },
};

function syncAllDay() {
  const on = $('#f-allday').checked;
  $('#time-pair').hidden = on;
  $('#end-date-box').hidden = !on || form.repeat > 0;
}

function plusHour(t, mins = 60) {
  const m = Math.min(minutes(t) + mins, 23 * 60 + 55);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function fillChoices(ev) {
  const cats = state.data.categories.filter((c) => !c.hidden || c.id === ev?.category);
  $('#f-category').innerHTML = cats.map((c) =>
    `<button type="button" class="pick" data-v="${c.id}" aria-pressed="false" style="--c:${c.color}"><i class="dot" style="background:${c.color}"></i>${esc(c.name)}</button>`).join('');
  const members = state.data.members.filter((m) => !m.hidden || ev?.members.includes(m.id));
  $('#f-members').innerHTML = members.length ? members.map((m) =>
    `<button type="button" class="pick" data-v="${m.id}" aria-pressed="false" style="--c:${m.color}"><i class="dot" style="background:${m.color}"></i>${esc(m.name)}</button>`).join('')
    : '<span class="small muted">Πρόσθεσε μέλη από τις Ρυθμίσεις.</span>';
  $('#title-suggestions').innerHTML = state.data.titles.map((t) => `<option value="${esc(t.title)}"></option>`).join('');
}

/**
 * Opens the window for a new activity (preset: date, start) or an existing one (ev, on the date tapped).
 */
function openEvent({ ev = null, date = null, start = null } = {}) {
  fillChoices(ev);
  state.editing = ev ? { event: ev, date } : null;
  state.timeTouched = !!start;
  $('#event-title').textContent = ev ? 'Δραστηριότητα' : 'Νέα δραστηριότητα';
  $('#event-delete').hidden = !ev;
  $('#event-err').hidden = true;
  const src = ev || {};
  $('#f-title').value = src.title || '';
  form.category = src.category || null;
  form.members = src.members || (state.filter.length === 1 ? state.filter : []);
  $('#f-date').value = ev ? date : (date || (state.view === 'week' && weekStart(today()) !== weekStart(state.anchor) ? weekStart(state.anchor) : today()));
  const allDay = ev ? !ev.start : false;
  $('#f-allday').checked = allDay;
  $('#f-start').value = ev ? (ev.start || '') : (start || '');
  $('#f-end').value = ev ? (ev.end || '') : (start ? plusHour(start) : '');
  $('#f-end-date').value = ev && ev.endDate !== ev.date ? addDays(date, diffDays(ev.date, ev.endDate)) : '';
  form.repeat = ev?.repeatDays ? (ev.repeatEvery || 1) : 0;
  form.days = ev?.repeatDays || [];
  $('#f-until').value = ev?.repeatUntil || '';
  $('#f-location').value = src.location || '';
  $('#f-notes').value = src.notes || '';
  const note = $('#series-note');
  note.hidden = !ev?.repeatDays;
  if (ev?.repeatDays) {
    note.textContent = `↻ ${ev.repeatEvery > 1 ? `Κάθε ${ev.repeatEvery} εβδομάδες` : 'Κάθε εβδομάδα'}: ${ev.repeatDays.map((d) => DAY_SHORT[d - 1]).join(', ')}, από ${shortDate(ev.date)}${ev.repeatUntil ? ` έως ${shortDate(ev.repeatUntil)}` : ''}. Εδώ βλέπεις την ${longDate(date)}.`;
  }
  syncAllDay();
  $('#event-dlg').showModal();
  if (!ev) setTimeout(() => $('#f-title').focus(), 50);
}

/** Typing a title used before fills in its usual category, people, time and place. */
function applyTemplate() {
  if (state.editing) return;
  const name = $('#f-title').value.trim().toLowerCase();
  const t = state.data.titles.find((x) => x.title.toLowerCase() === name);
  if (!t) return;
  if (!form.category && t.category) form.category = t.category;
  if (!form.members.length && t.members.length) form.members = t.members;
  if (t.start) {
    const dur = minutes(t.end) - minutes(t.start);
    if (!state.timeTouched || !$('#f-start').value) $('#f-start').value = t.start;
    $('#f-end').value = plusHour($('#f-start').value, dur);
    $('#f-allday').checked = false;
  }
  if (!$('#f-location').value && t.location) $('#f-location').value = t.location;
  syncAllDay();
}

function readForm() {
  const allDay = $('#f-allday').checked;
  const date = $('#f-date').value;
  const ev = {
    title: $('#f-title').value.trim(),
    category: form.category,
    members: form.members,
    date,
    start: allDay ? '' : $('#f-start').value,
    end: allDay ? '' : $('#f-end').value,
    endDate: allDay && form.repeat === 0 && $('#f-end-date').value ? $('#f-end-date').value : date,
    location: $('#f-location').value.trim(),
    notes: $('#f-notes').value.trim(),
    repeatDays: form.repeat ? form.days : null,
    repeatEvery: form.repeat || 1,
    repeatUntil: form.repeat ? $('#f-until').value : '',
  };
  if (!ev.title) return [null, 'Γράψε τι είναι.'];
  if (!date) return [null, 'Διάλεξε ημερομηνία.'];
  if (!allDay && !ev.start) return [null, 'Βάλε ώρα έναρξης ή διάλεξε «Όλη μέρα».'];
  if (!allDay && ev.end && ev.end <= ev.start) return [null, 'Η ώρα λήξης πρέπει να είναι μετά την έναρξη.'];
  if (ev.endDate < date) return [null, 'Το «μέχρι και» είναι πριν την ημερομηνία.'];
  if (form.repeat && !ev.repeatDays.length) return [null, 'Διάλεξε τουλάχιστον μία μέρα επανάληψης.'];
  if (form.repeat && ev.repeatUntil && ev.repeatUntil < date) return [null, 'Το «μέχρι» της επανάληψης είναι πριν την ημερομηνία.'];
  return [ev, null];
}

const SCOPES = [
  { label: 'Μόνο αυτή', value: 'one' },
  { label: 'Αυτή και επόμενες', value: 'following' },
  { label: 'Όλες', value: 'all', primary: true },
];

async function saveEvent(e) {
  e.preventDefault();
  const err = $('#event-err');
  err.hidden = true;
  const [ev, problem] = readForm();
  if (problem) { err.textContent = problem; err.hidden = false; return; }
  const btn = $('#event-save');
  const cur = state.editing;
  let scope = 'all';
  if (cur?.event.repeatDays) {
    scope = await ask({ title: 'Ποιες μέρες αλλάζουν;', text: `Άλλαξες την ${longDate(cur.date)}, που επαναλαμβάνεται.`, buttons: SCOPES });
    if (!scope) return;
    // The whole series keeps its first date; the date field shows the day that was tapped.
    if (scope === 'all' && ev.repeatDays) ev.date = addDays(cur.event.date, diffDays(cur.date, ev.date));
    if (scope === 'one') { ev.repeatDays = null; ev.endDate = ev.date; }
  }
  btn.disabled = true;
  try {
    if (cur) await api.update(cur.event.id, ev, scope, cur.event.repeatDays ? cur.date : null);
    else await api.add(ev);
    $('#event-dlg').close();
    toast(cur ? 'Αποθηκεύτηκε' : 'Προστέθηκε');
    if (!cur && (ev.date < neededRange()[0] || ev.date > neededRange()[1])) state.anchor = ev.date;
    await fetchData();
  } catch (x) {
    if (handleAuthError(x)) return;
    err.textContent = x.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function deleteEvent() {
  const cur = state.editing;
  if (!cur) return;
  let scope = 'all';
  if (cur.event.repeatDays) {
    scope = await ask({ title: 'Διαγραφή', text: `Η ${longDate(cur.date)} επαναλαμβάνεται. Τι να διαγραφεί;`, buttons: [
      { label: 'Μόνο αυτή', value: 'one' }, { label: 'Αυτή και επόμενες', value: 'following' }, { label: 'Όλες', value: 'all', danger: true }] });
  } else {
    scope = await ask({ title: `Διαγραφή «${cur.event.title}»;`, buttons: [{ label: 'Άκυρο', value: '' }, { label: 'Διαγραφή', value: 'all', danger: true }] });
  }
  if (!scope) return;
  try {
    await api.remove(cur.event.id, scope, cur.event.repeatDays ? cur.date : null);
    $('#event-dlg').close();
    toast('Διαγράφηκε');
    await fetchData();
  } catch (x) {
    if (handleAuthError(x)) return;
    toast(x.message, true);
  }
}

/* ------------------------------------------------------------ settings */

function renderSettings() {
  $('#settings-email').textContent = supa.userEmail();
  const row = (kind, x, i, list) => `
    <div class="manage-row${x.hidden ? ' hidden-cat' : ''}" data-kind="${kind}" data-id="${x.id}">
      <button type="button" class="swatch" data-act="color" style="background:${x.color}" aria-label="Χρώμα"></button>
      <input class="field" value="${esc(x.name)}" data-act="name" aria-label="Όνομα">
      <button type="button" class="icon-btn" data-act="hide" title="${x.hidden ? 'Εμφάνιση' : 'Απόκρυψη'}" aria-label="${x.hidden ? 'Εμφάνιση' : 'Απόκρυψη'}">${x.hidden
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'}</button>
      <button type="button" class="icon-btn" data-act="up" aria-label="Πάνω" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 15 6-6 6 6"/></svg></button>
    </div>`;
  $('#member-list').innerHTML = state.data.members.map((x, i, l) => row('members', x, i, l)).join('') || '<p class="small muted">Κανένα μέλος ακόμα.</p>';
  $('#cat-list').innerHTML = state.data.categories.map((x, i, l) => row('categories', x, i, l)).join('');
}

async function settingsCall(fn, okMsg) {
  const body = $('#settings-body');
  const err = $('#settings-err');
  err.hidden = true;
  body.classList.add('busy');
  try {
    await fn();
    await fetchData({ quiet: true });
    renderSettings();
    if (okMsg) toast(okMsg);
    return true;
  } catch (x) {
    if (handleAuthError(x)) return false;
    err.textContent = x.message;
    err.hidden = false;
    return false;
  } finally {
    body.classList.remove('busy');
  }
}

function initSettings() {
  $('#open-settings').addEventListener('click', () => {
    if (!state.data) return;
    renderSettings();
    $('#settings-err').hidden = true;
    $('#settings-dlg').showModal();
  });
  const save = (kind, x) => (kind === 'members' ? api.saveMember(x) : api.saveCategory(x));
  const list = (kind) => (kind === 'members' ? state.data.members : state.data.categories);
  $('#settings-body').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const row = b.closest('.manage-row');
    const kind = row.dataset.kind;
    const items = list(kind);
    const x = items.find((i) => i.id === Number(row.dataset.id));
    if (b.dataset.act === 'color') {
      const next = PALETTE[(PALETTE.indexOf(x.color) + 1) % PALETTE.length];
      settingsCall(() => save(kind, { ...x, color: next }));
    } else if (b.dataset.act === 'hide') {
      settingsCall(() => save(kind, { ...x, hidden: !x.hidden }), x.hidden ? 'Εμφανίζεται ξανά' : 'Κρύφτηκε από τις νέες καταχωρήσεις');
    } else if (b.dataset.act === 'up') {
      const ids = items.map((i) => i.id);
      const k = ids.indexOf(x.id);
      [ids[k - 1], ids[k]] = [ids[k], ids[k - 1]];
      settingsCall(() => api.order(kind, ids));
    }
  });
  $('#settings-body').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'name') return;
    const row = e.target.closest('.manage-row');
    const x = list(row.dataset.kind).find((i) => i.id === Number(row.dataset.id));
    const name = e.target.value.trim();
    if (!name) { e.target.value = x.name; return; }
    if (name !== x.name) settingsCall(() => save(row.dataset.kind, { ...x, name }), 'Μετονομάστηκε');
  });
  const unused = (items) => PALETTE.find((c) => !items.some((i) => i.color === c)) || PALETTE[items.length % PALETTE.length];
  $('#member-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#member-new').value.trim();
    if (!name) return;
    if (await settingsCall(() => api.saveMember({ name, color: unused(state.data.members) }), 'Προστέθηκε')) $('#member-new').value = '';
  });
  $('#cat-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#cat-new').value.trim();
    if (!name) return;
    if (await settingsCall(() => api.saveCategory({ name, color: unused(state.data.categories) }), 'Προστέθηκε')) $('#cat-new').value = '';
  });
  $('#logout').addEventListener('click', async () => {
    const ok = await ask({ title: 'Αποσύνδεση;', text: 'Θα αποσυνδεθείς και από τα οικογενειακά έξοδα σε αυτή τη συσκευή.',
      buttons: [{ label: 'Άκυρο', value: '' }, { label: 'Αποσύνδεση', value: 'ok', danger: true }] });
    if (!ok) return;
    $('#settings-dlg').close();
    await supa.signOut();
    forgetData();
    render();
  });
}

/* --------------------------------------------------------------- login */

function renderLogin() {
  let email = '';
  try { email = localStorage.getItem(LOGIN_EMAIL_KEY) || ''; } catch { /* ignore */ }
  $('#range-label').textContent = '';
  $('#main').innerHTML = `
    <div class="setup card">
      <h1>Σύνδεση</h1>
      <form id="login-form" novalidate>
        <p class="muted">Γράψε το email σου και θα σου έρθει ένα link σύνδεσης.</p>
        <label class="lbl" for="l-email">Email</label>
        <input class="field" id="l-email" type="email" inputmode="email" autocomplete="email" value="${esc(email)}" required>
        <div class="err" id="login-err" hidden></div>
        <div class="row-actions"><button class="btn primary" type="submit" id="login-send">Στείλε μου link</button></div>
      </form>
      <form id="code-form" novalidate hidden>
        <p class="muted">Στείλαμε email στο <b id="l-sent-to"></b>. Άνοιξέ το και πάτα το link σύνδεσης.</p>
        <p class="small muted">Αν το email έχει και κωδικό, μπορείς να τον γράψεις εδώ.</p>
        <label class="lbl" for="l-code">Κωδικός</label>
        <input class="field amount-input" id="l-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required>
        <div class="err" id="code-err" hidden></div>
        <div class="row-actions">
          <button class="btn" type="button" id="login-back">Άλλο email</button>
          <span class="spacer"></span>
          <button class="btn primary" type="submit" id="code-send">Σύνδεση</button>
        </div>
      </form>
      <p class="note">Ίδια σύνδεση με τα οικογενειακά έξοδα: αν είσαι ήδη συνδεδεμένος εκεί σε αυτή τη συσκευή, είσαι και εδώ. Μπαίνουν μόνο τα email που έχουν πρόσβαση.</p>
    </div>`;
  const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = label; };
  const fail = (el, msg) => { el.textContent = msg; el.hidden = false; };
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#login-err');
    err.hidden = true;
    const value = $('#l-email').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return fail(err, 'Γράψε ένα σωστό email.');
    const btn = $('#login-send');
    busy(btn, true, 'Αποστολή…');
    try {
      await supa.sendCode(value);
      try { localStorage.setItem(LOGIN_EMAIL_KEY, value); } catch { /* ignore */ }
      $('#l-sent-to').textContent = value;
      $('#login-form').hidden = true;
      $('#code-form').hidden = false;
      $('#l-code').focus();
    } catch (e) {
      fail(err, e.message);
    } finally {
      busy(btn, false, 'Στείλε μου link');
    }
  });
  $('#login-back').addEventListener('click', () => {
    $('#code-form').hidden = true;
    $('#login-form').hidden = false;
  });
  $('#code-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#code-err');
    err.hidden = true;
    const code = $('#l-code').value.replace(/\s/g, '');
    if (!/^\d{6,10}$/.test(code)) return fail(err, 'Ο κωδικός έχει μόνο αριθμούς (6 ψηφία ή περισσότερα).');
    const btn = $('#code-send');
    busy(btn, true, 'Έλεγχος…');
    try {
      await supa.verifyCode($('#l-sent-to').textContent, code);
      render();
      await fetchData();
    } catch (e) {
      fail(err, e.message);
      busy(btn, false, 'Σύνδεση');
    }
  });
}

/* ---------------------------------------------------------- navigation */

function step(n) {
  state.anchor = state.view === 'week' ? addDays(state.anchor, 7 * n) : addMonths(state.anchor, n);
  show();
}

function setView(view, anchor = null) {
  state.view = VIEWS.includes(view) ? view : 'week';
  if (anchor) state.anchor = anchor;
  savePrefs();
  if (location.hash.slice(1) !== state.view) history.replaceState(null, '', `#${state.view}`);
  show();
}

function openOccurrence(id, date) {
  const ev = state.data.events.find((e) => e.id === id);
  if (ev) openEvent({ ev, date });
}

function init() {
  const prefs = loadJson(PREFS_KEY, {});
  state.filter = Array.isArray(prefs.filter) ? prefs.filter : [];
  const hash = location.hash.slice(1);
  state.view = VIEWS.includes(hash) ? hash : (VIEWS.includes(prefs.view) ? prefs.view : 'week');
  try {
    if (supa.consumeRedirect()) { forgetData(); toast('Συνδέθηκες'); }
  } catch (e) {
    toast(e.message, true);
  }
  if (supa.signedIn()) state.data = loadJson(CACHE_KEY, null);

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  window.addEventListener('hashchange', () => { if (VIEWS.includes(location.hash.slice(1))) setView(location.hash.slice(1)); });
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  $('#today').addEventListener('click', () => { state.anchor = today(); show(); });
  $('#refresh').addEventListener('click', () => fetchData());
  $('#fab').addEventListener('click', () => openEvent());

  $('#who-filter').addEventListener('click', (e) => {
    const b = e.target.closest('.who');
    if (!b) return;
    const id = Number(b.dataset.id);
    if (!id) state.filter = [];
    else state.filter = state.filter.includes(id) ? state.filter.filter((x) => x !== id) : [...state.filter, id];
    if (state.filter.length >= state.data.members.filter((m) => !m.hidden).length) state.filter = [];
    savePrefs();
    render();
  });

  $('#main').addEventListener('click', (e) => {
    if (!state.data) return;
    const ev = e.target.closest('.ev, .chip');
    const cell = e.target.closest('.mo-cell');
    if (ev && (!cell || wide())) return openOccurrence(ev.dataset.id, ev.dataset.date);
    if (cell) return openDay(cell.dataset.day);
    const day = e.target.closest('.wk-day');
    if (day) return openDay(day.dataset.day);
    const col = e.target.closest('.wk-col');
    if (col) {
      // Tapping an empty hour starts a new activity at that half hour.
      const grid = col.closest('.wk-grid');
      const y = e.clientY - col.getBoundingClientRect().top;
      const m = Math.max(0, Math.floor(((y / HOUR_PX) * 60) / 30) * 30) + Number(grid.dataset.start) * 60;
      return openEvent({ date: col.dataset.day, start: `${pad(Math.min(23, Math.floor(m / 60)))}:${pad(m % 60)}` });
    }
  });
  $('#main').addEventListener('keydown', (e) => {
    const cell = e.target.closest('.mo-cell');
    if (cell && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDay(cell.dataset.day); }
  });

  // Swipe left or right to move a week or a month.
  let touch = null;
  $('#main').addEventListener('touchstart', (e) => { touch = e.touches.length === 1 ? [e.touches[0].clientX, e.touches[0].clientY] : null; }, { passive: true });
  $('#main').addEventListener('touchend', (e) => {
    if (!touch || !state.data) return;
    const dx = e.changedTouches[0].clientX - touch[0];
    const dy = e.changedTouches[0].clientY - touch[1];
    touch = null;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  $('#day-list').addEventListener('click', (e) => {
    const r = e.target.closest('.ag-row');
    if (!r) return;
    $('#day-dlg').close();
    openOccurrence(r.dataset.id, r.dataset.date);
  });
  $('#day-add').addEventListener('click', () => { const d = $('#day-dlg').dataset.day; $('#day-dlg').close(); openEvent({ date: d }); });
  $('#day-week').addEventListener('click', () => { const d = $('#day-dlg').dataset.day; $('#day-dlg').close(); setView('week', d); });

  // Event window controls.
  $('#f-days').innerHTML = DAY_LETTER.map((l, i) => `<button type="button" data-v="${i + 1}" aria-pressed="false" title="${DAY_LONG[i]}">${l}</button>`).join('');
  $('#f-repeat').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    form.repeat = Number(b.dataset.v);
    if (form.repeat && !form.days.length && $('#f-date').value) form.days = [weekday($('#f-date').value)];
    syncAllDay();
  });
  $('#f-days').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });
  $('#f-category').addEventListener('click', (e) => {
    const b = e.target.closest('.pick');
    if (b) form.category = b.getAttribute('aria-pressed') === 'true' ? null : Number(b.dataset.v);
  });
  $('#f-members').addEventListener('click', (e) => {
    const b = e.target.closest('.pick');
    if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });
  $('#f-allday').addEventListener('change', syncAllDay);
  $('#f-title').addEventListener('change', applyTemplate);
  $('#f-start').addEventListener('change', () => {
    const s = $('#f-start').value;
    state.timeTouched = true;
    if (s && (!$('#f-end').value || $('#f-end').value <= s)) $('#f-end').value = plusHour(s);
  });
  $('#event-form').addEventListener('submit', saveEvent);
  $('#event-delete').addEventListener('click', deleteEvent);

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  initSettings();

  // Back on the screen after a while: load what others added.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && supa.signedIn() && Date.now() - state.lastFetch > 60000) fetchData({ quiet: true });
  });
  // Keep the "now" line moving.
  setInterval(() => { if (state.view === 'week' && state.data && !document.querySelector('dialog[open]')) render(); }, 5 * 60000);

  render();
  if (supa.signedIn()) fetchData({ quiet: !!state.data });
}

init();
