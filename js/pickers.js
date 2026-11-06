// Date and time fields of the activity window: a rounded calendar and time wheels that open
// under the field, in place of the browser's own pickers. The <input>s stay (hidden) and keep
// their value, so the rest of the code reads and sets .value and hears 'change' as before.
import { pad, today, addMonths, monthGrid, weekday, monthName, DAY_LETTER, DAY_SHORT, shortDate } from './dates.js?v=33';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const ROW = 40; // height of one row of the time wheels
const ICON = {
  date: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
  time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};
const ARROW = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="${d}"/></svg>`;

let open = null; // { input, btn, panel, host, sync }

const fmt = (kind, v) => (kind === 'time' ? v : `${DAY_SHORT[weekday(v) - 1]} ${shortDate(v)} ${v.slice(0, 4)}`);
const change = (input) => input.dispatchEvent(new Event('change', { bubbles: true }));

/**
 * Turns a hidden <input> into a picker field.
 * kind: 'date' | 'time'. empty: text when there is no value. clearable: the calendar has «Καθαρισμός».
 * fallback(): where the picker starts when the field is empty.
 */
export function attachPicker(input, { kind, empty = '', clearable = false, fallback = () => '' }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `field pick-field ${kind}`;
  btn.id = `${input.id}-btn`;
  btn.setAttribute('aria-expanded', 'false');
  input.after(btn);
  const lbl = document.querySelector(`label[for="${input.id}"]`);
  if (lbl) lbl.htmlFor = btn.id;

  const paint = () => {
    const v = input.value;
    btn.innerHTML = `<span class="pf-text${v ? '' : ' muted'}"></span>${ICON[kind]}`;
    btn.firstChild.textContent = v ? fmt(kind, v) : (empty || (kind === 'time' ? '--:--' : '—'));
  };
  // Setting .value from code also updates the field and an open picker.
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() { return proto.get.call(this); },
    set(v) { proto.set.call(this, v); paint(); if (open?.input === input) open.sync(); },
  });
  input.focus = () => btn.focus();
  paint();

  btn.addEventListener('click', () => {
    if (open?.input === input) return closePicker();
    openPanel({ input, btn, kind, clearable, fallback });
  });
}

/** Closes the open picker; true if one was open. */
export function closePicker(instant = false) {
  if (!open) return false;
  const { panel, btn } = open;
  open = null;
  btn.setAttribute('aria-expanded', 'false');
  if (instant || reduce()) { panel.remove(); return true; }
  panel.getAnimations().forEach((a) => a.cancel());
  panel.animate([{ height: `${panel.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }],
    { duration: 200, easing: 'ease-in', fill: 'forwards' }).finished.then(() => panel.remove(), () => panel.remove());
  return true;
}

/** A tap anywhere else in the window closes the picker. */
export function closeOnOutside(root) {
  root.addEventListener('pointerdown', (e) => {
    if (!open || open.panel.contains(e.target) || e.target.closest('.pick-field')) return;
    closePicker();
  });
}

function openPanel(o) {
  const host = o.input.closest('.form-grid') || o.btn;
  // Moving to another field under the same row: the new picker grows from the height of the old one.
  let from = 0;
  if (open) {
    if (open.host === host) { from = open.panel.offsetHeight; open.btn.setAttribute('aria-expanded', 'false'); open.panel.remove(); open = null; }
    else closePicker();
  }
  const panel = document.createElement('div');
  panel.className = `picker ${o.kind}-picker`;
  panel.innerHTML = '<div class="picker-in"></div>';
  host.after(panel);
  const sync = (o.kind === 'date' ? buildDate : buildTime)(panel.firstChild, o);
  open = { input: o.input, btn: o.btn, panel, host, sync };
  o.btn.setAttribute('aria-expanded', 'true');
  const h = panel.offsetHeight;
  const done = () => panel.scrollIntoView({ block: 'nearest', behavior: reduce() ? 'auto' : 'smooth' });
  if (reduce()) return done();
  panel.animate([{ height: `${from}px`, opacity: from ? 1 : 0 }, { height: `${h}px`, opacity: 1 }],
    { duration: 280, easing: EASE }).finished.then(done, () => {});
}

/* ------------------------------------------------------------- calendar */

function buildDate(el, { input, clearable, fallback }) {
  let month = (input.value || fallback() || today()).slice(0, 7);
  el.innerHTML = `
    <div class="dp-head">
      <button type="button" class="icon-btn dp-prev" aria-label="Προηγούμενος μήνας">${ARROW('m15 18-6-6 6-6')}</button>
      <b class="dp-title"></b>
      <button type="button" class="icon-btn dp-next" aria-label="Επόμενος μήνας">${ARROW('m9 18 6-6-6-6')}</button>
    </div>
    <div class="dp-wd">${DAY_LETTER.map((l, i) => `<span${i > 4 ? ' class="we"' : ''}>${l}</span>`).join('')}</div>
    <div class="dp-grid"></div>
    ${clearable ? '<div class="dp-foot"><button type="button" class="dp-clear">Καθαρισμός</button></div>' : ''}`;
  const grid = el.querySelector('.dp-grid');
  const draw = (dir = 0) => {
    const t = today();
    const v = input.value;
    el.querySelector('.dp-title').textContent = monthName(`${month}-01`);
    grid.innerHTML = monthGrid(`${month}-01`).map((d) => {
      const cls = [d.slice(0, 7) !== month && 'out', d === t && 'today', d === v && 'sel', weekday(d) > 5 && 'we'].filter(Boolean).join(' ');
      return `<button type="button" class="dp-day ${cls}" data-d="${d}" aria-label="${d}"${d === v ? ' aria-current="date"' : ''}><span>${Number(d.slice(8))}</span></button>`;
    }).join('');
    if (dir && !reduce()) {
      grid.animate([{ transform: `translateX(${dir * 28}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: EASE });
    }
  };
  const go = (n) => { month = addMonths(`${month}-01`, n).slice(0, 7); draw(n); };
  el.querySelector('.dp-prev').addEventListener('click', () => go(-1));
  el.querySelector('.dp-next').addEventListener('click', () => go(1));
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.dp-day');
    if (!b) return;
    grid.querySelector('.sel')?.classList.remove('sel');
    b.classList.add('sel');
    input.value = b.dataset.d;
    change(input);
    setTimeout(() => { if (open?.input === input) closePicker(); }, 180);
  });
  el.querySelector('.dp-clear')?.addEventListener('click', () => {
    input.value = '';
    change(input);
    closePicker();
  });
  // Swipe sideways for the month before or after.
  let x0 = null;
  grid.addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 ? [e.touches[0].clientX, e.touches[0].clientY] : null; }, { passive: true });
  grid.addEventListener('touchend', (e) => {
    if (!x0) return;
    const dx = e.changedTouches[0].clientX - x0[0];
    const dy = e.changedTouches[0].clientY - x0[1];
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dy) < 40) go(dx < 0 ? 1 : -1);
  }, { passive: true });
  draw();
  return () => { if (input.value) month = input.value.slice(0, 7); draw(); };
}

/* ---------------------------------------------------------- time wheels */

function buildTime(el, { input, fallback }) {
  if (!input.value) {
    // Empty: start where it makes sense (e.g. an hour after the start), else now; like the phone's own wheel.
    const now = new Date();
    const m = Math.min(23 * 60 + 55, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5);
    input.value = fallback() || `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    change(input);
  }
  el.innerHTML = `<div class="tp">
    <div class="tp-band"></div>
    <div class="tp-col" data-k="h" tabindex="0" aria-label="Ώρα"></div>
    <span class="tp-colon">:</span>
    <div class="tp-col" data-k="m" tabindex="0" aria-label="Λεπτά"></div>
  </div>`;
  const [hc, mc] = el.querySelectorAll('.tp-col');
  const hours = Array.from({ length: 24 }, (_, i) => pad(i));
  const fill = () => {
    const [h, m] = input.value.split(':');
    const mins = Array.from({ length: 12 }, (_, i) => pad(i * 5));
    // A time saved before at an odd minute keeps its minute.
    if (!mins.includes(m)) mins.push(m), mins.sort();
    hc.innerHTML = hours.map((x) => `<div class="tp-item" data-v="${x}">${x}</div>`).join('');
    mc.innerHTML = mins.map((x) => `<div class="tp-item" data-v="${x}">${x}</div>`).join('');
    place(hc, h);
    place(mc, m);
  };
  const place = (col, v) => {
    const i = [...col.children].findIndex((c) => c.dataset.v === v);
    col.scrollTop = Math.max(0, i) * ROW;
    mark(col);
  };
  const index = (col) => Math.min(col.children.length - 1, Math.max(0, Math.round(col.scrollTop / ROW)));
  const mark = (col) => {
    const i = index(col);
    [...col.children].forEach((c, j) => c.classList.toggle('sel', i === j));
  };
  let selfSet = false;
  const commit = () => {
    const v = `${hc.children[index(hc)].dataset.v}:${mc.children[index(mc)].dataset.v}`;
    if (v === input.value) return;
    selfSet = true;
    input.value = v;
    selfSet = false;
    change(input);
  };
  for (const col of [hc, mc]) {
    let t;
    col.addEventListener('scroll', () => { mark(col); clearTimeout(t); t = setTimeout(commit, 120); }, { passive: true });
    col.addEventListener('click', (e) => {
      const it = e.target.closest('.tp-item');
      if (it) col.scrollTo({ top: [...col.children].indexOf(it) * ROW, behavior: reduce() ? 'auto' : 'smooth' });
    });
    col.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      col.scrollTo({ top: (index(col) + (e.key === 'ArrowUp' ? -1 : 1)) * ROW, behavior: reduce() ? 'auto' : 'smooth' });
    });
  }
  fill();
  // Changed from elsewhere (the start moved the end): turn the wheels to it.
  return () => { if (!selfSet && input.value) fill(); };
}
