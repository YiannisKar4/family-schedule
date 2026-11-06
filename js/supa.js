// A small Supabase client: email sign-in (code or magic link) and calls to the api_* functions.
// It uses Supabase's REST endpoints directly, so the site needs no extra library.
import { SUPABASE_URL, SUPABASE_ANON_KEY, SESSION_KEY } from './config.js?v=25';


export class AuthError extends Error {}

export const enabled = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let session = load();
let refreshing = null;

function load() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function store(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: stays signed in for this visit only */
  }
}

export const signedIn = () => !!(session && session.refresh_token);
export const userEmail = () => (session && session.email) || '';

function claims(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch {
    return {};
  }
}

function fromTokens(t) {
  const c = claims(t.access_token);
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Number(t.expires_at) || c.exp || Math.floor(Date.now() / 1000) + Number(t.expires_in || 3600),
    email: (t.user && t.user.email) || c.email || '',
  };
}

async function auth(path, body, token) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body || {}),
    });
  } catch {
    throw new AuthError('Δεν υπάρχει σύνδεση. Έλεγξε το internet.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.msg || data.error_description || data.message || '';
    if (res.status === 429) throw new AuthError('Πολλές προσπάθειες. Περίμενε λίγο και δοκίμασε ξανά.');
    if (/expired|invalid/i.test(msg) && path === 'verify') throw new AuthError('Ο κωδικός είναι λάθος ή έληξε. Ζήτησε νέο.');
    throw new AuthError(msg || `Σφάλμα σύνδεσης (${res.status})`);
  }
  return data;
}

/** Emails a sign-in code and link. The link brings the person back to this page. */
export async function sendCode(email) {
  const back = `${location.origin}${location.pathname}`;
  await auth(`otp?redirect_to=${encodeURIComponent(back)}`, { email, create_user: true });
}

/** Signs in with the code from the email. */
export async function verifyCode(email, code) {
  const data = await auth('verify', { type: 'email', email, token: code });
  store(fromTokens(data));
}

/**
 * Signs in from a magic link: the page opens with #access_token=… in the address.
 * Returns true when the address was a sign-in link (good or bad). Throws AuthError if it failed.
 */
export function consumeRedirect() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('access_token') && !h.has('error_description') && !h.has('error')) return false;
  history.replaceState(null, '', `${location.pathname}#week`);
  if (h.has('access_token') && h.has('refresh_token')) {
    store(fromTokens(Object.fromEntries(h)));
    return true;
  }
  const code = h.get('error_code') || '';
  throw new AuthError(/expired/i.test(code + h.get('error_description'))
    ? 'Το link σύνδεσης έληξε ή χρησιμοποιήθηκε ήδη. Ζήτησε νέο.'
    : h.get('error_description') || 'Η σύνδεση απέτυχε.');
}

async function refresh() {
  if (!session) throw new AuthError('login-required');
  if (!refreshing) {
    const rt = session.refresh_token;
    refreshing = auth('token?grant_type=refresh_token', { refresh_token: rt })
      .then((data) => store(fromTokens(data)))
      .catch((e) => {
        // Another tab may have refreshed already; use its tokens if so.
        const other = load();
        if (other && other.refresh_token !== rt) return store(other);
        if (e.message.startsWith('Δεν υπάρχει σύνδεση')) throw e;
        store(null);
        throw new AuthError('login-required');
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function token() {
  const other = load();
  if (other && session && other.refresh_token !== session.refresh_token) session = other;
  if (!session) throw new AuthError('login-required');
  if (session.expires_at - 60 < Date.now() / 1000) await refresh();
  return session.access_token;
}

/** The current login token, renewed first when it is about to expire (for Realtime). */
export const accessToken = token;

/** Calls one of the api_* database functions. Retries once after refreshing an expired login. */
export async function rpc(fn, args = {}, retried = false) {
  const t = await token();
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error('Δεν υπάρχει σύνδεση με τη βάση. Έλεγξε το internet.');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !retried) {
    await refresh();
    return rpc(fn, args, true);
  }
  if (res.status === 401) {
    store(null);
    throw new AuthError('login-required');
  }
  if (!res.ok) {
    const msg = (data && data.message) || `Σφάλμα βάσης (${res.status})`;
    if (msg === 'unauthorized') throw new AuthError('no-access');
    throw new Error(msg);
  }
  return data;
}

export async function signOut() {
  const t = session && session.access_token;
  store(null);
  if (t) await auth('logout', {}, t).catch(() => {});
}
