// Hold the + button: a microphone rises above it. Slide the finger onto it to dictate, let go to finish.
// Uses the browser's own speech recognition (Chrome on Android). Not offered on iPhone / iPad,
// or where the browser has no speech recognition: there the + button works as before.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const supported = !!SR && !ios;

const HOLD_MS = 380;
const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

/**
 * fab: the + button. onText(text) gets what was said, once the finger lets go.
 * Returns { busy(on) } to show "thinking" while the text is being understood.
 */
export function attachVoice(fab, { onText, onError }) {
  if (!supported) return { busy() {} };

  const scrim = document.createElement('div');
  scrim.className = 'vc-scrim';
  const mic = document.createElement('div');
  mic.className = 'vc-mic';
  mic.innerHTML = MIC_SVG;
  const bubble = document.createElement('div');
  bubble.className = 'vc-bubble';
  bubble.innerHTML = '<small></small><span></span>';
  bubble.setAttribute('aria-live', 'polite');
  document.body.append(scrim, mic, bubble);
  const label = bubble.querySelector('small');
  const said = bubble.querySelector('span');

  let timer = 0, open = false, held = false, rec = null, listening = false, heard = '', live = '', thinking = false;

  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* not allowed */ } };
  const show = () => {
    const t = (heard + ' ' + live).trim();
    said.textContent = t.length > 220 ? `…${t.slice(-220)}` : t;
  };

  function place() {
    const r = fab.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    mic.style.left = `${cx - 26}px`;
    mic.style.top = `${r.top - 52 - 28}px`;
    bubble.style.bottom = `${innerHeight - r.top + 52 + 44}px`;
  }

  function openMenu() {
    open = true; held = true; heard = ''; live = '';
    place();
    label.textContent = 'Κράτα το δάχτυλο κάτω και σύρε το στο μικρόφωνο';
    show();
    document.documentElement.classList.add('vc-open');
    buzz(15);
  }

  function closeMenu() {
    open = false;
    stopListening();
    document.documentElement.classList.remove('vc-open', 'vc-rec');
  }

  function startListening() {
    if (listening) return;
    listening = true;
    document.documentElement.classList.add('vc-rec');
    label.textContent = 'Ακούω… Άφησε το δάχτυλο όταν τελειώσεις';
    buzz(10);
    rec = listen();
  }

  /**
   * One phrase at a time (continuous off): Chrome on Android repeats earlier words when it runs
   * continuously. Each phrase's text is rebuilt from its results, never added to, and kept when
   * the phrase ends; while the finger is still on the microphone the next phrase starts.
   */
  function listen() {
    const r = new SR();
    r.lang = 'el-GR';
    r.continuous = false;
    r.interimResults = true;
    let mine = '';
    r.onresult = (e) => {
      mine = [...e.results].map((x) => x[0].transcript).join(' ').replace(/\s+/g, ' ').trim();
      live = mine;
      show();
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        closeMenu();
        onError?.('Δώσε άδεια για το μικρόφωνο και δοκίμασε ξανά.');
      }
    };
    r.onend = () => {
      if (mine) heard = `${heard} ${mine}`.trim();
      if (live === mine) live = '';
      mine = '';
      show();
      if (rec === r && listening && open) rec = listen();
      else if (r.done) r.done();
    };
    try { r.start(); } catch { /* already running */ }
    return r;
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    document.documentElement.classList.remove('vc-rec');
    const r = rec;
    rec = null;
    try { r.stop(); } catch { /* ended */ }
    if (open) label.textContent = 'Σταμάτησε. Σύρε ξανά στο μικρόφωνο για συνέχεια';
  }

  function overMic(x, y) {
    const r = mic.getBoundingClientRect(), pad = 20;
    return x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad;
  }

  /** Speech arrives a moment after the finger lets go; wait for the last words. */
  function finish() {
    const r = rec;
    const wasListening = listening;
    listening = false;
    rec = null;
    if (!wasListening || !r) { closeMenu(); return; }
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      const text = (heard + ' ' + live).trim();
      closeMenu();
      if (text) onText(text);
      else onError?.('Δεν ακούστηκε τίποτα. Δοκίμασε ξανά.');
    };
    r.done = end;
    setTimeout(end, 1200);
    try { r.stop(); } catch { end(); }
  }

  fab.classList.add('vc-fab');
  fab.addEventListener('contextmenu', (e) => e.preventDefault());
  fab.addEventListener('pointerdown', (e) => {
    held = false;
    if (thinking || e.button > 0) return;
    try { fab.setPointerCapture(e.pointerId); } catch { /* fine */ }
    clearTimeout(timer);
    timer = setTimeout(openMenu, HOLD_MS);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!open) return;
    const inside = overMic(e.clientX, e.clientY);
    if (inside && !listening) startListening();
    else if (!inside && listening) stopListening();
  });
  const up = (e) => {
    clearTimeout(timer);
    if (!open) return;
    if (e.type === 'pointercancel') closeMenu();
    else finish();
  };
  fab.addEventListener('pointerup', up);
  fab.addEventListener('pointercancel', up);
  // After a hold, the release is not a tap: the «Νέο» window must not open as well.
  fab.addEventListener('click', (e) => {
    if (held) { held = false; e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  return {
    busy(on) {
      thinking = on;
      document.documentElement.classList.toggle('vc-busy', on);
      if (on) { place(); label.textContent = 'Το σκέφτομαι…'; }
    },
  };
}
