// Sends the family schedule's push notifications (reminders and "someone changed something").
// Supabase Edge Function. pg_cron calls it every minute (supabase/push-cron.sql).
// It asks the database what is due (sched_push_due) and sends each one with Web Push:
// the browser standard (RFC 8030 / 8291 / 8292), so no Firebase or other service is needed.
// It uses only the built-in Web Crypto, so it is one file with nothing to install.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor, name "sched-push",
// paste this file, then turn off "Verify JWT" for it (the cron call carries its own secret).

const SITE = 'https://yianniskar4.github.io/family-schedule/';

const enc = new TextEncoder();
// deno-lint-ignore no-explicit-any
const Deno = (globalThis as any).Deno; // undefined when the tests import this file in Node

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** A new VAPID key pair: the public key as base64url (for the browser), the private one as a JWK. */
export async function makeKeys(): Promise<{ publicKey: string; privateKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  return {
    publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey,
  };
}

/** The payload encrypted for one browser (RFC 8291, aes128gcm). */
export async function encrypt(payload: Uint8Array, p256dh: string, authSecret: string): Promise<Uint8Array> {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, body);
}

/** The Authorization header that proves the message comes from us (RFC 8292). */
export async function vapidAuth(endpoint: string, publicKey: string, privateKey: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

// who: whose picture and colour the phone shows ({ id, name, color, photo }), or null for the logo.
type Who = { id: number; name: string; color: string; photo: boolean } | null;
type Msg = { endpoint: string; p256dh: string; auth: string; title: string; body: string; date: string; tag: string; who: Who };

export async function send(m: Msg, publicKey: string, privateKey: JsonWebKey): Promise<number> {
  const payload = enc.encode(JSON.stringify({ title: m.title, body: m.body, date: m.date, tag: m.tag, who: m.who }));
  const res = await fetch(m.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(m.endpoint, publicKey, privateKey),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '3600',
      Urgency: 'high',
    },
    body: await encrypt(payload, m.p256dh, m.auth),
  });
  await res.body?.cancel();
  return res.status;
}

// The project's service key, which Supabase gives every Edge Function: the legacy service_role
// JWT, or else the new secret key.
function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')).default; } catch { return ''; }
}

async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const key = serviceKey();
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, ...(key.startsWith('ey') ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function handle(req: Request): Promise<Response> {
  let cfg = await rpc('sched_push_config_get');
  if (req.headers.get('x-cron-secret') !== cfg.cronSecret) return new Response('forbidden', { status: 403 });
  if (!cfg.vapidPublic) {
    const k = await makeKeys();
    cfg = await rpc('sched_push_set_keys', { public_key: k.publicKey, private_key: k.privateKey });
  }
  const due: Msg[] = await rpc('sched_push_due');
  const gone: string[] = [];
  const failed: string[] = [];
  await Promise.all(due.map(async (m) => {
    try {
      const status = await send(m, cfg.vapidPublic, cfg.vapidPrivate);
      if (status === 404 || status === 410) gone.push(m.endpoint);
      else if (status >= 400) failed.push(`${status} ${new URL(m.endpoint).host}`);
    } catch (e) {
      failed.push(String(e));
    }
  }));
  if (gone.length) await rpc('sched_push_gone', { endpoints: [...new Set(gone)] });
  if (failed.length) console.error('push failed:', failed);
  return Response.json({ sent: due.length - gone.length - failed.length, gone: gone.length, failed });
}

if (Deno) Deno.serve(handle);
