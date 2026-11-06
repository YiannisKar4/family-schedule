// Family schedule: week and month calendar, quick add, weekly series.
import * as supa from './supa.js?v=26';
import * as api from './api.js?v=26';
import * as live from './live.js?v=26';
import { ApiError } from './api.js?v=26';
import { STORAGE_PREFIX } from './config.js?v=26';
import { attachPlaces } from './places.js?v=26';
import {
  today, addDays, addMonths, weekStart, monthGrid, weekday, minutes, pad, diffDays,
  expand, lanes, DAY_SHORT, DAY_LETTER, DAY_LONG, monthName, longDate, shortDate, rangeLabel,
} from './dates.js?v=26';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CACHE_KEY = `${STORAGE_PREFIX}.cache`;
const PREFS_KEY = `${STORAGE_PREFIX}.prefs`;
const LOGIN_EMAIL_KEY = `${STORAGE_PREFIX}.loginEmail`;
const VIEWS = ['week', 'month'];
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#00a3b4', '#52514e'];
// Height of one hour in the week view; taller on a phone, where the columns are narrow.
const narrow = matchMedia('(max-width: 600px)');
const hourPx = () => (narrow.matches ? 60 : 44);
// Weeks drawn on either side of the shown week, so a swipe glides on without redrawing.
const WEEKS_AROUND = 4;
const wide = () => matchMedia('(min-width: 700px)').matches;

const state = {
  view: 'week',
  anchor: today(),
  data: null, // { members, categories, events, titles, from, to }
  filter: [], // member ids whose activities stand out; the rest fade. Empty = none fade.
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
    return [addDays(f, -7 * WEEKS_AROUND), addDays(f, 7 * WEEKS_AROUND + 6)];
  }
  const g = monthGrid(state.anchor);
  return [g[0], g[41]];
}

/** Loads about three months around what is on screen. */
async function fetchData({ quiet = false } = {}) {
  // Asked again while loading (e.g. a live change arrived): load once more afterwards.
  if (state.loading) { state.again = true; return; }
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
    if (state.again) { state.again = false; fetchData({ quiet: true }); }
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
  live.stop();
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

/** True when the activity is one of the picked people's, or a family one (nobody set), or nobody is picked. */
function picked(ev) {
  if (!state.filter.length || !ev.members.length) return true;
  return ev.members.some((id) => state.filter.includes(id));
}
const fade = (ev) => (picked(ev) ? '' : ' faded');
const off = (ev) => (ev.cancelled ? ' cancelled' : '');

function occurrences(from, to) {
  return expand(state.data.events, from, to);
}

const timeText = (o) => (o.allDay ? 'Όλη μέρα' : `${o.start}–${o.end}`);
const membersText = (ev) => ev.members.map((id) => memberById(id)?.name).filter(Boolean).join(', ');
/** A member's photo, or the first letter of the name on their colour. */
const avatar = (m) => (m.photo
  ? `<img src="${esc(m.photo)}" alt="">`
  : `<span class="initial">${esc([...m.name.trim()][0] || '?')}</span>`);
/** Who is on an activity: small overlapping circles with each person's photo, or their initial on their colour. */
function faces(ev, small = false) {
  const ms = ev.members.map(memberById).filter(Boolean);
  if (!ms.length) return '';
  return `<span class="faces${small ? ' sm' : ''}">${ms.map((m) => `<i style="--c:${m.color}" title="${esc(m.name)}">${m.photo
    ? `<img src="${esc(m.photo)}" alt="">` : esc([...m.name.trim()][0] || '?')}</i>`).join('')}</span>`;
}

/* -------------------------------------------------------------- render */

function render() {
  const ready = supa.signedIn() && state.data;
  $('#tabs-wrap').hidden = !ready;
  $('#people').hidden = true;
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
  renderPeople();
  if (state.view === 'month') renderMonth();
  else renderWeek();
}

/**
 * The circles: tap one or more to make their activities stand out (the others fade but stay),
 * tap again to let go.
 */
function renderPeople() {
  const members = state.data.members.filter((m) => !m.hidden);
  state.filter = state.filter.filter((id) => members.some((m) => m.id === id));
  const box = $('#people');
  box.hidden = !members.length;
  box.classList.toggle('picking', state.filter.length > 0);
  box.innerHTML = members.map((m) => { const on = state.filter.includes(m.id); return `<button type="button" class="person${on ? ' on' : ''}" data-id="${m.id}"
      style="--c:${m.color}" aria-pressed="${on}" aria-label="${esc(m.name)}" title="${esc(m.name)}"><span class="ph">${avatar(m)}</span><span class="nm">${esc(m.name)}</span></button>`; }).join('');
}

/**
 * Updates the circles and the faded activities in place, without drawing the calendar again,
 * so the change fades smoothly instead of jumping.
 */
let reorderTimer;
function applyPicks() {
  const box = $('#people');
  box.classList.toggle('picking', state.filter.length > 0);
  box.querySelectorAll('.person').forEach((b) => {
    const on = state.filter.includes(Number(b.dataset.id));
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('.ev[data-id], .chip[data-id], .ag-row[data-id]').forEach((el) => {
    const ev = state.data.events.find((x) => x.id === el.dataset.id);
    if (ev) el.classList.toggle('faded', !picked(ev));
  });
}

function renderWeek() {
  const from = weekStart(state.anchor);
  // The days run on: a few weeks before and after are drawn too, so a swipe flows into them.
  const first = addDays(from, -7 * WEEKS_AROUND);
  const days = Array.from({ length: 7 * (2 * WEEKS_AROUND + 1) }, (_, i) => addDays(first, i));
  $('#range-label').textContent = rangeLabel(from, addDays(from, 6));
  const occ = occurrences(days[0], days[days.length - 1]);
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
  const HOUR_PX = hourPx();

  const head = days.map((d, i) => `<button type="button" class="wk-day${i % 7 > 4 ? ' we' : ''}${d === t ? ' today' : ''}" data-day="${d}">
      <span class="wd">${DAY_SHORT[i % 7]}</span><span class="dn">${Number(d.slice(8))}</span></button>`).join('');
  const allDayRow = allDay.some((l) => l.length) ? `<div class="wk-allday"><div class="gutter small muted">όλη<br>μέρα</div>${allDay.map((list, i) =>
    `<div class="ad-cell${i % 7 > 4 ? ' we' : ''}">${list.map((o) => chip(o, days[i])).join('')}</div>`).join('')}</div>` : '';
  const gutter = Array.from({ length: hours }, (_, i) => `<div class="hr" style="top:${i * HOUR_PX}px">${pad(startH + i)}:00</div>`).join('');
  const cols = timed.map((list, i) => {
    const d = days[i];
    const blocks = list.map((o) => {
      const top = ((minutes(o.start) - startH * 60) / 60) * HOUR_PX;
      const h = Math.max(((minutes(o.end) - minutes(o.start)) / 60) * HOUR_PX, 22);
      const w = 100 / o.lanes;
      // Room inside the block: title lines of 13px, then rows of 15px with the time and who.
      // A second row (for who) only when two title lines still fit above it.
      const room = h - 3;
      const short = room < 28;
      const rl = room >= 56 ? 2 : 1;
      const tl = Math.min(3, Math.floor((room - rl * 15) / 13));
      return `<button type="button" class="ev${short ? ' short' : ''}${fade(o.event)}${off(o.event)}" data-id="${o.event.id}" data-date="${d}"
        style="top:${top}px;height:${h - 2}px;left:calc(${o.lane * w}% + 1px);width:calc(${w}% - 2px);--c:${colorOf(o.event)};--tl:${tl};--rl:${rl}">
        ${short ? `<span class="ev-row"><span class="ev-s">${o.start}</span><span class="ev-t">${esc(o.event.title)}</span></span>`
    : `<span class="ev-t">${esc(o.event.title)}</span><span class="ev-s"><span>${o.start}</span>${faces(o.event, true)}</span>`}</button>`;
    }).join('');
    let now = '';
    if (d === t) {
      const n = new Date();
      const m = n.getHours() * 60 + n.getMinutes() - startH * 60;
      if (m >= 0 && m <= hours * 60) now = `<div class="now" style="top:${(m / 60) * HOUR_PX}px"></div>`;
    }
    return `<div class="wk-col${i % 7 ? '' : ' mon'}${i % 7 > 4 ? ' we' : ''}${d === t ? ' today' : ''}" data-day="${d}">${blocks}${now}</div>`;
  }).join('');

  const empty = !occ.some((o) => o.date <= addDays(from, 6) && (o.endDate || o.date) >= from) ? `<p class="empty small">Τίποτα αυτή την εβδομάδα. Πάτα σε μια ώρα ή στο «Νέο» για να προσθέσεις.</p>` : '';
  $('#main').innerHTML = `
    <div class="week card" style="--n:${days.length}">
      <div class="wk-top"><div class="wk-head"><div class="gutter"></div>${head}</div></div>
      <div class="wk-body">
        ${allDayRow}
        <div class="wk-grid" style="height:${hours * HOUR_PX}px;--hour:${HOUR_PX}px" data-start="${startH}">
          <div class="gutter">${gutter}</div>${cols}
        </div>
      </div>
    </div>${empty}`;
  weekScroll(from, first);
}

/**
 * A week shows (on a phone about three and a half days of it) and the days run on into the
 * weeks around it. The day names follow the sideways scroll. When the scroll stops in another
 * week, that week becomes the shown one without drawing anything again; only near the ends of
 * what is drawn is it drawn again around the new week, at the same place.
 * On a phone a week opens on today, elsewhere on its Monday.
 */
let settleTimer;
let touching = false;
function weekScroll(from, first) {
  const body = $('.wk-body');
  const top = $('.wk-top');
  const gut = body.querySelector('.wk-grid > .gutter').offsetWidth;
  const dayW = body.querySelector('.wk-col').getBoundingClientRect().width;
  const count = body.querySelectorAll('.wk-col').length;
  const last = addDays(first, count - 1);
  const t = today();
  let day = from;
  if (state.weekDay && state.weekDay.day >= first && state.weekDay.day <= last) day = state.weekDay.day;
  else if (narrow.matches && t >= from && t <= addDays(from, 6)) day = t;
  body.scrollLeft = body.querySelector(`.wk-col[data-day="${day}"]`).offsetLeft - gut;
  top.scrollLeft = body.scrollLeft;
  state.weekDay = { day };

  const settle = () => {
    if (touching || !document.body.contains(body)) return;
    const d = state.weekDay.day;
    if (weekStart(d) === weekStart(state.anchor)) return;
    state.anchor = d;
    const [f, to] = neededRange();
    if (!state.data || f < state.data.from || to > state.data.to) return fetchData({ quiet: true });
    // Close to the ends of what is drawn: draw again around this week (the picture stays put).
    if ((d < addDays(first, 7) || d > addDays(last, -10)) && !document.querySelector('dialog[open]')) render();
  };
  body.addEventListener('scroll', () => {
    top.scrollLeft = body.scrollLeft;
    const d = addDays(first, Math.min(count - 1, Math.max(0, Math.round(body.scrollLeft / dayW))));
    state.weekDay = { day: d };
    const w = weekStart(d);
    $('#range-label').textContent = rangeLabel(w, addDays(w, 6));
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 250);
  }, { passive: true });
  body.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  const up = () => { touching = false; clearTimeout(settleTimer); settleTimer = setTimeout(settle, 250); };
  body.addEventListener('touchend', up, { passive: true });
  body.addEventListener('touchcancel', up, { passive: true });
}

function chip(o, day) {
  const cont = o.date < day ? ' cont' : '';
  return `<button type="button" class="chip${cont}${fade(o.event)}${off(o.event)}" data-id="${o.event.id}" data-date="${o.date}" style="--c:${colorOf(o.event)}">${faces(o.event, true)}${o.allDay ? '' : `<b>${o.start}</b> `}${esc(o.event.title)}</button>`;
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
      // The picked people's activities first, so they are not hidden behind "+N".
      const list = occ.filter((o) => o.date <= d && o.endDate >= d)
        .sort((a, b) => Number(picked(b.event)) - Number(picked(a.event)));
      const more = list.length - max;
      return `<div class="mo-cell${d.slice(0, 7) !== m ? ' out' : ''}${d === t ? ' today' : ''}" data-day="${d}" role="button" tabindex="0" aria-label="${esc(longDate(d))}, ${list.length} δραστηριότητες">
        <span class="mo-dn">${Number(d.slice(8))}</span>
        ${list.slice(0, more > 0 ? max - 1 : max).map((o) => chip(o, d)).join('')}
        ${more > 0 ? `<span class="more">+${more + 1}</span>` : ''}
      </div>`;
    }).join('')}</div>
  </div>`;
  if (state.slide) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) $('.month').animate([{ transform: `translateX(${state.slide * 48}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'ease-out' });
    state.slide = 0;
  }
}

/* ----------------------------------------------------------- day window */

function openDay(d) {
  const list = occurrences(d, d);
  $('#day-title').textContent = longDate(d);
  $('#day-list').innerHTML = list.length ? list.map((o) => `
    <button type="button" class="ag-row${fade(o.event)}${off(o.event)}" data-id="${o.event.id}" data-date="${o.date}" style="--c:${colorOf(o.event)}">
      <span class="ag-time">${o.allDay ? 'Όλη<br>μέρα' : `${o.start}<br><span class="muted">${o.end}</span>`}</span>
      <span class="ag-main"><b>${faces(o.event, true)}${esc(o.event.title)}</b>
        <span class="small muted">${esc([membersText(o.event), o.event.location].filter(Boolean).join(' · '))}${o.series ? ' · ↻' : ''}${o.event.cancelled ? ' · Ακυρώθηκε' : ''}</span></span>
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
    : '<span class="small muted">Δεν υπάρχουν μέλη.</span>';
  $('#title-suggestions').innerHTML = state.data.titles.map((t) => `<option value="${esc(t.title)}"></option>`).join('');
}

/** "Άλλο", or no category: the activity needs its own title. Any other category is its own title. */
function needsTitle(catId) {
  const c = catId && categoryById(catId);
  return !c || c.name.trim().toLowerCase() === 'άλλο';
}

/** Shows "Τι" only where it says something: for "Άλλο", no category, or an older activity with its own title. */
function syncTitle() {
  const cat = form.category;
  const src = state.editing?.event || state.copyOf;
  const own = src && src.category === cat && src.title !== categoryById(cat)?.name;
  $('#title-box').hidden = !(needsTitle(cat) || own);
}

/** A link that opens the place in Maps (the app on a phone or tablet). */
function syncMap() {
  const place = $('#f-location').value.trim();
  const a = $('#f-map');
  a.hidden = !place;
  a.href = place ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}` : '';
}

/**
 * Opens the window for a new activity (preset: date, start) or an existing one (ev, on the date tapped).
 */
function openEvent({ ev = null, date = null, start = null } = {}) {
  fillChoices(ev);
  state.editing = ev ? { event: ev, date } : null;
  state.copyOf = null;
  state.timeTouched = !!start;
  $('#event-title').textContent = ev ? 'Δραστηριότητα' : 'Νέα δραστηριότητα';
  $('#event-delete').hidden = !ev;
  $('#event-copy').hidden = !ev;
  $('#cancel-box').hidden = !ev;
  $('#f-cancelled').checked = !!ev?.cancelled;
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
  syncTitle();
  syncMap();
  $('#event-dlg').showModal();
}

/**
 * Turns the open activity into a new one with the same details, to save on another date.
 * A copy is a single activity: repeating can be turned on again by hand.
 */
function copyEvent() {
  const cur = state.editing;
  if (!cur) return;
  state.copyOf = cur.event;
  state.editing = null;
  $('#event-title').textContent = 'Αντίγραφο';
  $('#event-delete').hidden = true;
  $('#event-copy').hidden = true;
  $('#cancel-box').hidden = true;
  $('#f-cancelled').checked = false;
  $('#series-note').hidden = true;
  $('#event-err').hidden = true;
  form.repeat = 0;
  form.days = [];
  $('#f-until').value = '';
  syncAllDay();
  syncTitle();
  toast('Άλλαξε ό,τι θέλεις και πάτα Αποθήκευση');
  $('#f-date').focus();
}

/**
 * A title used before (typed, or the name of the category picked) fills in its usual
 * category, people, time and place.
 */
function applyTemplate(title = $('#f-title').value) {
  if (state.editing) return;
  const name = title.trim().toLowerCase();
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
  syncTitle();
  syncMap();
}

function readForm() {
  const allDay = $('#f-allday').checked;
  const date = $('#f-date').value;
  const titled = !$('#title-box').hidden;
  const ev = {
    title: titled ? $('#f-title').value.trim() : (categoryById(form.category)?.name || ''),
    category: form.category,
    members: form.members,
    date,
    start: allDay ? '' : $('#f-start').value,
    end: allDay ? '' : $('#f-end').value,
    endDate: allDay && form.repeat === 0 && $('#f-end-date').value ? $('#f-end-date').value : date,
    location: $('#f-location').value.trim(),
    notes: $('#f-notes').value.trim(),
    cancelled: !$('#cancel-box').hidden && $('#f-cancelled').checked,
    repeatDays: form.repeat ? form.days : null,
    repeatEvery: form.repeat || 1,
    repeatUntil: form.repeat ? $('#f-until').value : '',
  };
  if (!ev.title) return [null, form.category ? 'Γράψε τι είναι.' : 'Διάλεξε κατηγορία ή γράψε τι είναι.'];
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
    <div class="manage-row${x.hidden ? ' hidden-cat' : ''}${kind === 'members' ? ' with-photo' : ''}" data-kind="${kind}" data-id="${x.id}">
      ${kind === 'members' ? `<button type="button" class="mini-av" data-act="photo" style="--c:${x.color}"
        aria-label="${x.photo ? 'Φωτογραφία: αλλαγή ή αφαίρεση' : 'Βάλε φωτογραφία'}">${avatar(x)}</button>` : ''}
      <button type="button" class="swatch" data-act="color" style="background:${x.color}" aria-label="Χρώμα"></button>
      <input class="field" value="${esc(x.name)}" data-act="name" aria-label="Όνομα">
      <button type="button" class="icon-btn" data-act="hide" title="${x.hidden ? 'Εμφάνιση' : 'Απόκρυψη'}" aria-label="${x.hidden ? 'Εμφάνιση' : 'Απόκρυψη'}">${x.hidden
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'}</button>
      <button type="button" class="icon-btn" data-act="up" aria-label="Πάνω" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 15 6-6 6 6"/></svg></button>
      <div class="palette" hidden>${PALETTE.map((c) => `<button type="button" data-act="pick" data-color="${c}" style="background:${c}"
        aria-label="Χρώμα ${c}" aria-pressed="${c === x.color}"></button>`).join('')}</div>
    </div>`;
  $('#member-list').innerHTML = state.data.members.map((x, i, l) => row('members', x, i, l)).join('') || '<p class="small muted">Κανένα μέλος ακόμα.</p>';
  $('#cat-list').innerHTML = state.data.categories.map((x, i, l) => row('categories', x, i, l)).join('');
}

/**
 * Turns a photo from the phone or tablet into a small square JPEG (data URL), cut from the middle
 * and a little towards the top, where faces usually are.
 */
async function shrinkPhoto(file, size = 320) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const s = Math.min(w, h);
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    c.getContext('2d').drawImage(img, (w - s) / 2, (h - s) * 0.3, s, s, 0, 0, size, size);
    for (const q of [0.85, 0.7, 0.55]) {
      const data = c.toDataURL('image/jpeg', q);
      if (data.length < 190000) return data;
    }
    throw new Error('too big');
  } finally {
    URL.revokeObjectURL(url);
  }
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

const THEME_KEY = 'sched.theme';

/** Light, dark or the system's. Saved on this device only; index.html applies it before first paint. */
function theme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

function setTheme(t) {
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch { /* private mode */ }
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  renderThemeSeg();
}

function renderThemeSeg() {
  const t = theme();
  document.querySelectorAll('#theme-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeOpt === t)));
}

function initSettings() {
  renderThemeSeg();
  $('#theme-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme-opt]');
    if (b) setTheme(b.dataset.themeOpt);
  });
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
    if (b.dataset.act === 'photo') {
      // The picker must open inside a tap, or phones and tablets block it.
      const pick = () => {
        $('#photo-input').dataset.id = x.id;
        $('#photo-input').value = '';
        $('#photo-input').click();
      };
      if (!x.photo) return pick();
      const onTap = (ev) => { if (ev.target.closest('button')?.value === 'change') pick(); };
      $('#ask-actions').addEventListener('click', onTap);
      ask({ title: `Φωτογραφία: ${x.name}`, buttons: [
        { label: 'Άκυρο', value: '' }, { label: 'Αφαίρεση', value: 'remove' }, { label: 'Αλλαγή', value: 'change', primary: true }] })
        .then((v) => {
          $('#ask-actions').removeEventListener('click', onTap);
          if (v === 'remove') settingsCall(() => api.memberPhoto(x.id, null), 'Η φωτογραφία αφαιρέθηκε');
        });
    } else if (b.dataset.act === 'color') {
      // Opens this row's colours and closes any other.
      const pal = $('.palette', row);
      const open = pal.hidden;
      $('#settings-body').querySelectorAll('.palette').forEach((p) => { p.hidden = true; });
      pal.hidden = !open;
    } else if (b.dataset.act === 'pick') {
      if (b.dataset.color === x.color) { $('.palette', row).hidden = true; return; }
      settingsCall(() => save(kind, { ...x, color: b.dataset.color }));
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
  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const id = Number(e.target.dataset.id);
    if (!file || !id) return;
    let photo;
    try {
      photo = await shrinkPhoto(file);
    } catch {
      $('#settings-err').textContent = 'Δεν άνοιξε αυτή η φωτογραφία. Δοκίμασε άλλη.';
      $('#settings-err').hidden = false;
      return;
    }
    settingsCall(() => api.memberPhoto(id, photo), 'Η φωτογραφία μπήκε');
  });
  const unused = (items) => PALETTE.find((c) => !items.some((i) => i.color === c)) || PALETTE[items.length % PALETTE.length];
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
    live.stop();
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
      startLive();
    } catch (e) {
      fail(err, e.message);
      busy(btn, false, 'Σύνδεση');
    }
  });
}

/* ---------------------------------------------------------- navigation */

/** Next or previous week or month. The week glides there; the month slides in. */
function step(n) {
  const body = $('.wk-body');
  if (state.view === 'week' && body) {
    const day = state.weekDay ? state.weekDay.day : weekStart(state.anchor);
    // Land on the Monday (on a phone the same weekday) of the week before or after.
    const target = narrow.matches ? addDays(day, 7 * n) : addDays(weekStart(day), 7 * n);
    const col = body.querySelector(`.wk-col[data-day="${target}"]`);
    if (col) {
      body.scrollTo({ left: col.offsetLeft - body.querySelector('.wk-grid > .gutter').offsetWidth, behavior: 'smooth' });
      return;
    }
    state.anchor = addDays(state.anchor, 7 * n);
    state.weekDay = null;
    return show();
  }
  state.anchor = state.view === 'week' ? addDays(state.anchor, 7 * n) : addMonths(state.anchor, n);
  state.slide = n;
  show();
}

function setView(view, anchor = null) {
  state.view = VIEWS.includes(view) ? view : 'week';
  if (anchor) { state.anchor = anchor; state.weekDay = null; }
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
  state.filter = Array.isArray(prefs.filter) ? prefs.filter.filter(Number.isInteger) : [];
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
  $('#today').addEventListener('click', () => {
    // In the week view, glide to today when it is drawn; otherwise jump.
    const body = $('.wk-body');
    const t = today();
    const target = state.view === 'week' && body && body.querySelector(`.wk-col[data-day="${narrow.matches ? t : weekStart(t)}"]`);
    if (target) return body.scrollTo({ left: target.offsetLeft - body.querySelector('.wk-grid > .gutter').offsetWidth, behavior: 'smooth' });
    state.anchor = t; state.weekDay = null; show();
  });
  $('#refresh').addEventListener('click', () => fetchData());
  $('#fab').addEventListener('click', () => openEvent());

  $('#people').addEventListener('click', (e) => {
    const b = e.target.closest('.person');
    if (!b) return;
    const id = Number(b.dataset.id);
    state.filter = state.filter.includes(id) ? state.filter.filter((x) => x !== id) : [...state.filter, id];
    savePrefs();
    applyPicks();
    // The month lists the picked people's activities first: reorder once the fade has played.
    clearTimeout(reorderTimer);
    if (state.view === 'month') reorderTimer = setTimeout(() => { if (!document.querySelector('dialog[open]')) render(); }, 400);
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
      const m = Math.max(0, Math.floor(((y / hourPx()) * 60) / 30) * 30) + Number(grid.dataset.start) * 60;
      return openEvent({ date: col.dataset.day, start: `${pad(Math.min(23, Math.floor(m / 60)))}:${pad(m % 60)}` });
    }
  });
  $('#main').addEventListener('keydown', (e) => {
    const cell = e.target.closest('.mo-cell');
    if (cell && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDay(cell.dataset.day); }
  });

  // Swipe left or right to move a month. The week view scrolls on its own instead.
  let touch = null;
  $('#main').addEventListener('touchstart', (e) => { touch = e.touches.length === 1 ? [e.touches[0].clientX, e.touches[0].clientY] : null; }, { passive: true });
  $('#main').addEventListener('touchend', (e) => {
    if (!touch || !state.data || state.view === 'week') return;
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
    if (!b) return;
    form.category = b.getAttribute('aria-pressed') === 'true' ? null : Number(b.dataset.v);
    syncTitle();
    if (form.category && !needsTitle(form.category)) applyTemplate(categoryById(form.category).name);
  });
  $('#f-location').addEventListener('input', syncMap);
  attachPlaces($('#f-location'), syncMap);
  $('#f-members').addEventListener('click', (e) => {
    const b = e.target.closest('.pick');
    if (b) b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
  });
  $('#f-allday').addEventListener('change', syncAllDay);
  $('#f-title').addEventListener('change', () => applyTemplate());
  $('#f-start').addEventListener('change', () => {
    const s = $('#f-start').value;
    state.timeTouched = true;
    if (s && (!$('#f-end').value || $('#f-end').value <= s)) $('#f-end').value = plusHour(s);
  });
  $('#event-form').addEventListener('submit', saveEvent);
  $('#event-delete').addEventListener('click', deleteEvent);
  $('#event-copy').addEventListener('click', copyEvent);

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  initSettings();

  // Back on the screen after a while: load what others added.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && supa.signedIn() && Date.now() - state.lastFetch > 60000) fetchData({ quiet: true });
  });
  // The circles stay in sight when the calendar scrolls: on a wide or sideways screen in the
  // top bar, between the week and «Σήμερα»; on an upright phone in the bottom bar, next to the tabs.
  const peopleInBar = matchMedia('(orientation: landscape), (min-width: 700px)');
  const placePeople = () => {
    const box = $('#people');
    if (peopleInBar.matches) $('#range-nav').after(box);
    else $('.tabs').append(box);
    box.classList.toggle('in-bar', peopleInBar.matches);
    box.classList.toggle('in-tabs', !peopleInBar.matches);
  };
  placePeople();
  peopleInBar.addEventListener('change', placePeople);
  // The day names stick just under the top bar, whatever its height.
  const bar = $('.topbar');
  new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`)).observe(bar);
  // Phone and wider screens use different hour heights.
  narrow.addEventListener('change', () => { if (state.view === 'week' && state.data) render(); });
  // Keep the "now" line moving.
  setInterval(() => { if (state.view === 'week' && state.data && !document.querySelector('dialog[open]')) render(); }, 5 * 60000);

  render();
  if (supa.signedIn()) {
    fetchData({ quiet: !!state.data });
    startLive();
  }
}

/** Loads again whenever someone (e.g. on another phone) changes something. */
function startLive() {
  live.start(() => { if (supa.signedIn()) fetchData({ quiet: true }); });
}

/**
 * Phones: keep open windows inside the part of the screen that is visible.
 * On iPhone the keyboard and the date/time wheel cover the page without shrinking it,
 * so a window anchored to the bottom would hide its Save button behind them.
 */
function trackVisibleArea() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  const update = () => {
    if (vv.scale > 1.05) { root.removeProperty('--vv-h'); root.removeProperty('--vv-below'); return; }
    const below = Math.max(0, document.documentElement.clientHeight - vv.height - vv.offsetTop);
    root.setProperty('--vv-h', `${Math.round(vv.height)}px`);
    root.setProperty('--vv-below', `${Math.round(below)}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

trackVisibleArea();
init();
