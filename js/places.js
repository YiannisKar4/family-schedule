// Place suggestions while typing, from Photon (OpenStreetMap). Free, no key.
// Free text still works: a suggestion only fills the field when tapped.

const URL_BASE = 'https://photon.komoot.io/api/';
const MIN_CHARS = 3;
const WAIT_MS = 300;
const LIMIT = 6;
// Results near Athens come first; places elsewhere still show up.
const BIAS = { lat: 38.0, lon: 23.75 };

const cache = new Map();

/** One line for a result: name, then street and number, then area. */
export function label(p) {
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const area = p.city || p.district || p.locality || p.county || p.state;
  const parts = [p.name, street, area];
  if (p.country && p.countrycode && p.countrycode !== 'GR') parts.push(p.country);
  const out = [];
  for (const s of parts) if (s && !out.includes(s)) out.push(s);
  return out.join(', ');
}

async function search(q, signal) {
  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const params = new URLSearchParams({ q, limit: String(LIMIT), lat: String(BIAS.lat), lon: String(BIAS.lon) });
  const res = await fetch(`${URL_BASE}?${params}`, { signal });
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const data = await res.json();
  const seen = new Set();
  const list = [];
  for (const f of data.features || []) {
    const text = label(f.properties || {});
    if (text && !seen.has(text)) { seen.add(text); list.push(text); }
  }
  cache.set(key, list);
  return list;
}

/**
 * Adds suggestions under `input`. `onPick` runs after a suggestion fills the field.
 * Returns `close` so the caller can hide the list (e.g. when the window opens).
 */
export function attachPlaces(input, onPick = () => {}) {
  const box = document.createElement('ul');
  box.className = 'place-list';
  box.id = `${input.id}-list`;
  box.setAttribute('role', 'listbox');
  box.hidden = true;
  input.closest('.place-row').after(box);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', box.id);
  input.setAttribute('aria-expanded', 'false');

  let timer = 0;
  let ctrl = null;
  let items = [];
  let active = -1;

  const close = () => {
    clearTimeout(timer);
    ctrl?.abort();
    items = [];
    active = -1;
    box.hidden = true;
    box.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const mark = (i) => {
    active = i;
    [...box.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', box.children[i].id);
    else input.removeAttribute('aria-activedescendant');
  };

  const show = (list) => {
    items = list;
    active = -1;
    box.replaceChildren(...list.map((text, i) => {
      const li = document.createElement('li');
      li.id = `${box.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.textContent = text;
      return li;
    }));
    box.hidden = !list.length;
    input.setAttribute('aria-expanded', String(!!list.length));
    if (list.length) box.scrollIntoView({ block: 'nearest' });
  };

  const pick = (i) => {
    if (!items[i]) return;
    input.value = items[i];
    close();
    onPick();
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    ctrl?.abort();
    const q = input.value.trim();
    if (q.length < MIN_CHARS) { show([]); return; }
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      try {
        const list = await search(q, ctrl.signal);
        if (input.value.trim() === q && document.activeElement === input) show(list);
      } catch (e) {
        if (e.name !== 'AbortError') show([]); // offline or service down: typing still works
      }
    }, WAIT_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); mark((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark(active <= 0 ? items.length - 1 : active - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });

  // Keep focus in the field while tapping a suggestion, so blur does not hide it first.
  box.addEventListener('pointerdown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) pick([...box.children].indexOf(li));
  });
  input.addEventListener('blur', close);

  return close;
}
