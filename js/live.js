// Live updates. The page keeps one connection open to Supabase Realtime, and the database tells it
// when someone changes an activity, a member or a category. Only then does the page load the data again.
// Supabase's Realtime protocol (Phoenix channels) is spoken directly, so no extra library is needed.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=28';
import * as supa from './supa.js?v=28';

const TABLES = ['sched_events', 'sched_skips', 'sched_members', 'sched_categories'];
const TOPIC = 'realtime:schedule';

let ws = null;
let ref = 0;
let joinRef = '';
let beat = null;
let retries = 0;
let retryTimer = null;
let tokenSent = '';
let wasConnected = false;
let wanted = false;
let onChange = () => {};
let changeTimer = null;

function send(event, payload, topic = TOPIC) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return '';
  const r = String(++ref);
  if (event === 'phx_join') joinRef = r;
  ws.send(JSON.stringify({ topic, event, payload, ref: r, join_ref: topic === TOPIC ? joinRef : null }));
  return r;
}

// Several rows change together (a series edit, a reorder): load once.
function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => onChange(), 400);
}

async function connect() {
  clearTimeout(retryTimer);
  if (ws || !wanted || !supa.signedIn() || document.visibilityState !== 'visible') return;
  let token;
  try { token = await supa.accessToken(); } catch { return; }
  if (ws) return;
  const url = `${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}&vsn=1.0.0`;
  const socket = new WebSocket(url);
  ws = socket;
  socket.onopen = () => {
    tokenSent = token;
    send('phx_join', {
      config: {
        broadcast: { self: false }, presence: { key: '' }, private: false,
        postgres_changes: TABLES.map((table) => ({ event: '*', schema: 'public', table })),
      },
      access_token: token,
    });
    beat = setInterval(heartbeat, 25000);
  };
  socket.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.topic !== TOPIC) return;
    if (msg.event === 'postgres_changes') changed();
    else if (msg.event === 'phx_reply' && msg.payload?.status === 'ok' && msg.ref === joinRef) {
      retries = 0;
      // Back after a break: something may have changed meanwhile.
      if (wasConnected) changed();
      wasConnected = true;
    } else if ((msg.event === 'phx_reply' && msg.payload?.status === 'error') || msg.event === 'phx_error' || msg.event === 'phx_close') {
      socket.close();
    }
  };
  socket.onclose = () => {
    clearInterval(beat);
    if (ws === socket) ws = null;
    if (!wanted) return;
    // Try again, waiting longer each time (1 s, 2 s, 4 s … up to 30 s).
    retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retries++));
  };
}

// Keeps the connection open, and hands Realtime the new login after it is renewed (about every hour).
async function heartbeat() {
  send('heartbeat', {}, 'phoenix');
  try {
    const t = await supa.accessToken();
    if (t !== tokenSent) {
      tokenSent = t;
      send('access_token', { access_token: t });
    }
  } catch { /* signed out: the next call to the database will say so */ }
}

/** Starts listening. `callback` runs (at most once per burst) when someone changes something. */
export function start(callback) {
  onChange = callback;
  wanted = true;
  connect();
}

/** Stops listening, e.g. on sign-out. */
export function stop() {
  wanted = false;
  wasConnected = false;
  clearTimeout(retryTimer);
  clearTimeout(changeTimer);
  if (ws) ws.close();
  ws = null;
}

// A phone or tablet that goes to sleep drops the connection: open it again when the page is back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { retries = 0; connect(); }
});
