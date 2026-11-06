// Dates as 'YYYY-MM-DD' strings in local time, and the dates of weekly series.
// No time zones: a family schedule is always read where the family lives.

export const pad = (n) => String(n).padStart(2, '0');

export function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12); // noon: never lands on the wrong day around clock changes
}

export const today = () => iso(new Date());

export function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}

/** Days from a to b. */
export const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);

/** 1 = Monday … 7 = Sunday. */
export function weekday(s) {
  return parse(s).getDay() || 7;
}

export const weekStart = (s) => addDays(s, 1 - weekday(s));

export function monthStart(s) {
  return `${s.slice(0, 7)}-01`;
}

export function addMonths(s, n) {
  const d = parse(monthStart(s));
  d.setMonth(d.getMonth() + n);
  return iso(d);
}

/** The 6 × 7 grid of a month view, starting on Monday. */
export function monthGrid(s) {
  const first = weekStart(monthStart(s));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

export const minutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export const DAY_SHORT = ['Δευ', 'Τρι', 'Τετ', 'Πεμ', 'Παρ', 'Σαβ', 'Κυρ'];
export const DAY_LETTER = ['Δ', 'Τ', 'Τ', 'Π', 'Π', 'Σ', 'Κ'];
export const DAY_LONG = ['Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο', 'Κυριακή'];
const MONTHS = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος', 'Ιούλιος',
  'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];
const MONTHS_OF = ['Ιανουαρίου', 'Φεβρουαρίου', 'Μαρτίου', 'Απριλίου', 'Μαΐου', 'Ιουνίου', 'Ιουλίου',
  'Αυγούστου', 'Σεπτεμβρίου', 'Οκτωβρίου', 'Νοεμβρίου', 'Δεκεμβρίου'];
const MONTHS_SHORT = ['Ιαν', 'Φεβ', 'Μαρ', 'Απρ', 'Μαΐ', 'Ιουν', 'Ιουλ', 'Αυγ', 'Σεπ', 'Οκτ', 'Νοε', 'Δεκ'];

export const monthName = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
export const longDate = (s) => `${DAY_LONG[weekday(s) - 1]} ${Number(s.slice(8))} ${MONTHS_OF[Number(s.slice(5, 7)) - 1]}`;
export const shortDate = (s) => `${Number(s.slice(8))} ${MONTHS_SHORT[Number(s.slice(5, 7)) - 1]}`;

export function rangeLabel(from, to) {
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${Number(to.slice(8))} ${MONTHS_SHORT[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  return `${shortDate(from)} – ${shortDate(to)} ${to.slice(0, 4)}`;
}

/**
 * Every appearance of the events between from and to (inclusive), sorted.
 * Each one: { event, date, endDate, start, end, allDay, series }.
 * A weekly series appears on its weekdays, every `repeatEvery` weeks counted from the week
 * it starts, until repeatUntil, except on its skipped dates.
 */
export function expand(events, from, to) {
  const out = [];
  for (const e of events) {
    const allDay = !e.start;
    if (!e.repeatDays) {
      if (e.date <= to && e.endDate >= from) out.push({ event: e, date: e.date, endDate: e.endDate, start: e.start, end: e.end, allDay, series: false });
      continue;
    }
    const last = e.repeatUntil && e.repeatUntil < to ? e.repeatUntil : to;
    const first = e.date > from ? e.date : from;
    const skips = new Set(e.skips || []);
    const every = e.repeatEvery || 1;
    const week0 = weekStart(e.date);
    for (let d = first; d <= last; d = addDays(d, 1)) {
      if (!e.repeatDays.includes(weekday(d)) || skips.has(d)) continue;
      if (every > 1 && Math.floor(diffDays(week0, d) / 7) % every) continue;
      out.push({ event: e, date: d, endDate: d, start: e.start, end: e.end, allDay, series: true });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1)
    || String(a.start).localeCompare(String(b.start))
    || a.event.title.localeCompare(b.event.title, 'el'));
}

/**
 * Side-by-side columns for the timed events of one day, so overlapping ones do not cover each other.
 * Sets .lane and .lanes on each item.
 */
export function lanes(items) {
  const sorted = [...items].sort((a, b) => minutes(a.start) - minutes(b.start) || minutes(b.end) - minutes(a.end));
  let group = [];
  let groupEnd = -1;
  const ends = [];
  const close = () => {
    const n = Math.max(1, ...group.map((x) => x.lane + 1));
    for (const x of group) x.lanes = n;
    group = [];
    ends.length = 0;
  };
  for (const it of sorted) {
    const s = minutes(it.start);
    const e = Math.max(minutes(it.end), s + 20);
    if (s >= groupEnd) { close(); groupEnd = -1; }
    let lane = ends.findIndex((end) => end <= s);
    if (lane < 0) { lane = ends.length; ends.push(e); } else ends[lane] = e;
    it.lane = lane;
    group.push(it);
    groupEnd = Math.max(groupEnd, e);
  }
  close();
  return sorted;
}
