// A stand-in for a Supabase project, for trying the site locally.
// It runs supabase/schema.sql on an in-process PostgreSQL (PGlite) and imitates the parts of
// Supabase the site uses: email sign-in (code or magic link), token refresh, /rest/v1/rpc, and
// Realtime (a websocket that announces changes after any api_* call other than api_sched_read).
//
//   node dev/supabase-mock.mjs [data.sql]
//   open http://localhost:8090 and sign in as a@example.com (or an email from data.sql)
//
// The site is served on SITE_PORT (8090) and the "Supabase" API on API_PORT (8091), a different
// origin like the real thing. Sent emails are not sent: GET /__mail?email=… on the API port shows
// the last code and magic link. Env JWT_TTL (seconds, default 3600) makes logins expire sooner.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url).pathname;
const SITE_PORT = Number(process.env.SITE_PORT || 8090);
const API_PORT = Number(process.env.API_PORT || 8091);
const API = `http://localhost:${API_PORT}`;
const ANON_KEY = 'anon-test';
const JWT_TTL = Number(process.env.JWT_TTL || 3600);

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public revoke execute on functions from public;
`);
// Builds the schema and loads the data. Called at start and by POST /__reset, so tests
// can start from clean data without restarting the server.
async function seed() {
  await db.exec(`
    drop schema if exists public cascade; create schema public;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public revoke execute on functions from public;
  `);
  await db.exec(fs.readFileSync(`${root}supabase/schema.sql`, 'utf8'));
  if (process.argv[2]) {
    await db.exec(fs.readFileSync(process.argv[2], 'utf8'));
  } else {
    const H = '00000000-0000-4000-8000-000000000001';
    // A sample family. Dates are relative to this week, so the site always has something to show.
    await db.exec(`
      insert into households (id, name) values ('${H}', 'Test');
      insert into allowed_emails values ('a@example.com', '${H}'), ('b@example.com', '${H}');
      insert into sched_members (household_id, name, color, sort_order) values
        ('${H}', 'Γιάννης', '#2a78d6', 0), ('${H}', 'Μαρία', '#e87ba4', 1), ('${H}', 'Νίκος', '#1baf7a', 2), ('${H}', 'Ελένη', '#eda100', 3);
      insert into sched_categories (household_id, name, color, sort_order) values
        ('${H}', 'Σχολείο', '#2a78d6', 0), ('${H}', 'Δουλειά', '#52514e', 1), ('${H}', 'Ποδόσφαιρο', '#1baf7a', 2),
        ('${H}', 'Λογοθεραπεία', '#6250d6', 3), ('${H}', 'Γιατρός', '#e34948', 4), ('${H}', 'Οικογένεια', '#eda100', 5), ('${H}', 'Άλλο', '#898781', 6);
    `);
    await db.exec(`
      with w as (select date_trunc('week', now())::date as mon),
      c as (select name, id from sched_categories), m as (select name, id from sched_members)
      insert into sched_events (household_id, title, category_id, member_ids, start_date, end_date, start_time, end_time, location, repeat_days)
      select '${H}', t.title, (select id from c where c.name = t.cat), coalesce((select array_agg(id) from m where m.name = any(t.who)), '{}'),
             w.mon + t.d, w.mon + t.d, t.s::time, t.e::time, t.loc, t.days
      from w, (values
        ('Σχολείο', 'Σχολείο', array['Νίκος','Ελένη'], -60, '08:15', '13:30', '', array[1,2,3,4,5]::smallint[]),
        ('Γραφείο', 'Δουλειά', array['Γιάννης'], -60, '09:00', '17:00', '', array[1,2,4]::smallint[]),
        ('Ποδόσφαιρο', 'Ποδόσφαιρο', array['Νίκος'], -30, '18:00', '19:30', 'Γήπεδο', array[2,4]::smallint[]),
        ('Λογοθεραπεία', 'Λογοθεραπεία', array['Ελένη'], -30, '16:30', '17:15', '', array[3]::smallint[]),
        ('Οδοντίατρος', 'Γιατρός', array['Μαρία','Ελένη'], 4, '17:30', '18:15', '', null),
        ('Τραπέζι γιαγιά', 'Οικογένεια', null::text[], 6, '13:30', '16:00', '', null)
      ) t(title, cat, who, d, s, e, loc, days);
      insert into sched_events (household_id, title, category_id, member_ids, start_date, end_date)
      select '${H}', 'Σχολική εκδρομή', (select id from sched_categories where name = 'Σχολείο'),
             array[(select id from sched_members where name = 'Νίκος')], date_trunc('week', now())::date + 9, date_trunc('week', now())::date + 10;
    `);
  }
}
await seed();

// ------------------------------------------------------------------- auth

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const users = new Map(); // email -> id
const mail = new Map(); // email -> { code, magic, used }
const refreshTokens = new Map(); // token -> { email, revoked }
let rpcCalls = 0;

function userId(email) {
  if (!users.has(email)) users.set(email, crypto.randomUUID());
  return users.get(email);
}

function issue(email) {
  const exp = Math.floor(Date.now() / 1000) + JWT_TTL;
  const access = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: userId(email), email, role: 'authenticated', exp })}.mock`;
  const refresh = crypto.randomBytes(12).toString('hex');
  refreshTokens.set(refresh, { email, revoked: false });
  return { access_token: access, token_type: 'bearer', expires_in: JWT_TTL, expires_at: exp, refresh_token: refresh, user: { id: userId(email), email } };
}

function readJwt(header) {
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m || m[1] === ANON_KEY) return null;
  try {
    const c = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString());
    if (m[1].split('.')[2] !== 'mock') return 'invalid';
    if (c.exp < Date.now() / 1000) return 'expired';
    return c;
  } catch {
    return 'invalid';
  }
}

// -------------------------------------------------------------------- rpc

async function callRpc(fn, args, claims) {
  const params = (await db.query(
    `select unnest(proargnames) n, unnest(string_to_array(oidvectortypes(proargtypes), ', ')) t
     from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn])).rows;
  if (!params.length && !(await db.query(`select 1 from pg_proc where proname = $1`, [fn])).rows.length) {
    return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
  }
  const names = Object.keys(args);
  const values = names.map((n) => {
    const v = args[n];
    if (v === null || v === undefined) return null;
    return typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  const list = names.map((n, i) => {
    const p = params.find((x) => x.n === n);
    if (!p) throw Object.assign(new Error(`Could not find the function public.${fn}(${names.join(', ')})`), { http: 404 });
    return `${n} => $${i + 1}::${p.t}`;
  });
  try {
    const r = await db.transaction(async (tx) => {
      if (claims) {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await tx.exec('set local role authenticated');
      } else {
        await tx.exec('set local role anon');
      }
      return tx.query(`select ${fn}(${list.join(', ')}) as r`, values);
    });
    rpcCalls++;
    if (fn !== 'api_sched_read') announce(fn);
    return { status: 200, body: r.rows[0].r };
  } catch (e) {
    if (e.http) return { status: e.http, body: { message: e.message } };
    const status = e.code === '42501' ? (claims ? 403 : 401) : 400;
    return { status, body: { code: e.code, message: e.message, details: null, hint: null } };
  }
}

// --------------------------------------------------------------- realtime
// Just enough of a websocket server and of Supabase Realtime's channel protocol for the site.

const sockets = new Set(); // joined sockets
let liveMessages = 0;

function frame(text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length])
    : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
      : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255])]);
  return Buffer.concat([head, data]);
}

function wsSend(sock, msg) {
  if (!sock.destroyed) sock.write(frame(JSON.stringify(msg)));
}

function announce(fn) {
  for (const s of sockets) {
    liveMessages++;
    wsSend(s, { topic: s.topic, event: 'postgres_changes', ref: null,
      payload: { ids: [1], data: { type: 'UPDATE', schema: 'public', table: fn, commit_timestamp: new Date().toISOString() } } });
  }
}

function upgrade(req, sock) {
  const url = new URL(req.url, API);
  if (url.pathname !== '/realtime/v1/websocket' || url.searchParams.get('apikey') !== ANON_KEY) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      let len = buf[1] & 127;
      let at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      const masked = buf[1] & 128;
      if (buf.length < at + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(at, at + 4) : null;
      at += masked ? 4 : 0;
      const body = Buffer.from(buf.subarray(at, at + len));
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      buf = buf.subarray(at + len);
      if (op === 8) { sockets.delete(sock); sock.end(); return; }
      if (op !== 1) continue;
      let msg;
      try { msg = JSON.parse(body.toString()); } catch { continue; }
      const reply = (status, response = {}) => wsSend(sock, { topic: msg.topic, event: 'phx_reply', ref: msg.ref, join_ref: msg.join_ref, payload: { status, response } });
      if (msg.event === 'phx_join') {
        const c = readJwt(`Bearer ${msg.payload?.access_token}`);
        if (!c || typeof c !== 'object') { reply('error', { reason: 'invalid token' }); continue; }
        sock.topic = msg.topic;
        sockets.add(sock);
        reply('ok', { postgres_changes: [] });
      } else if (msg.event === 'heartbeat' || msg.event === 'access_token') {
        reply('ok');
      }
    }
  });
  sock.on('close', () => sockets.delete(sock));
  sock.on('error', () => sockets.delete(sock));
}

// ----------------------------------------------------------------- servers

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, API);
  const reply = (status, body, h) => send(res, status, body, { ...cors, ...h });
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  // Test helpers (not part of Supabase).
  if (url.pathname === '/__mail') return reply(200, mail.get(url.searchParams.get('email')) || {});
  if (url.pathname === '/__stats') return reply(200, { rpcCalls, refreshTokens: refreshTokens.size, liveSockets: sockets.size, liveMessages });
  // Drops every live connection, as when a phone goes to sleep.
  if (url.pathname === '/__drop' && req.method === 'POST') { for (const s of sockets) s.destroy(); sockets.clear(); return reply(200, { ok: true }); }
  if (url.pathname === '/__reset' && req.method === 'POST') { await seed(); rpcCalls = 0; return reply(200, { ok: true }); }
  // Stops the mock, so tests don't have to kill it.
  if (url.pathname === '/__quit' && req.method === 'POST') { reply(200, { ok: true }); setTimeout(() => process.exit(0), 50); return; }
  if (url.pathname === '/__sql' && req.method === 'POST') {
    let sql = ''; for await (const c of req) sql += c;
    return reply(200, (await db.query(sql)).rows);
  }

  // Magic link in the email: GET /auth/v1/verify?token=…&type=magiclink&redirect_to=…
  if (url.pathname === '/auth/v1/verify' && req.method === 'GET') {
    const back = url.searchParams.get('redirect_to');
    const entry = [...mail.entries()].find(([, m]) => m.magic === url.searchParams.get('token'));
    if (!entry || entry[1].used) {
      return reply(303, '', { Location: `${back}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` });
    }
    entry[1].used = true;
    const t = issue(entry[0]);
    const h = new URLSearchParams({ access_token: t.access_token, expires_at: t.expires_at, expires_in: t.expires_in, refresh_token: t.refresh_token, token_type: 'bearer', type: 'magiclink' });
    return reply(303, '', { Location: `${back}#${h}` });
  }

  if (req.headers.apikey !== ANON_KEY) return reply(401, { message: 'No API key found in request' });
  let raw = ''; for await (const c of req) raw += c;
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { message: 'bad json' }); }

  if (url.pathname === '/auth/v1/otp') {
    const email = String(body.email || '').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return reply(400, { code: 400, msg: 'Unable to validate email address: invalid format' });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const magic = crypto.randomBytes(8).toString('hex');
    const redirect = url.searchParams.get('redirect_to') || `http://localhost:${SITE_PORT}/`;
    mail.set(email, { code, magic, used: false, link: `${API}/auth/v1/verify?token=${magic}&type=magiclink&redirect_to=${encodeURIComponent(redirect)}` });
    console.log(`[mail] ${email}: code ${code}`);
    return reply(200, {});
  }
  if (url.pathname === '/auth/v1/verify') {
    const m = mail.get(String(body.email || '').toLowerCase());
    if (body.type !== 'email' || !m || m.used || m.code !== String(body.token)) {
      return reply(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
    }
    m.used = true;
    return reply(200, issue(body.email.toLowerCase()));
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    const t = refreshTokens.get(body.refresh_token);
    if (!t || t.revoked) return reply(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
    t.revoked = true;
    return reply(200, issue(t.email));
  }
  if (url.pathname === '/auth/v1/logout') {
    const c = readJwt(req.headers.authorization);
    if (c && typeof c === 'object') for (const t of refreshTokens.values()) if (t.email === c.email) t.revoked = true;
    return reply(204, '');
  }

  // The dictation function (supabase/functions/sched-ai), without Gemini: a fixed reading of the
  // words, enough to see the window fill in. Names and categories said are picked up as they are.
  if (url.pathname === '/functions/v1/sched-ai' && req.method === 'POST') {
    const claims = readJwt(req.headers.authorization);
    if (!claims || claims === 'expired' || claims === 'invalid') return reply(401, { error: 'Η σύνδεση έληξε. Συνδέσου ξανά.' });
    const a = body;
    const t = (a.text || '').toLowerCase();
    const d = new Date(`${a.today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
    const timed = /\d/.test(t);
    return reply(200, {
      category: a.categories.find((c) => t.includes(c.toLowerCase())) || '', title: '',
      members: a.members.filter((m) => t.includes(m.toLowerCase())), date: d.toISOString().slice(0, 10),
      allDay: !timed, start: timed ? '18:00' : '', end: timed ? '19:30' : '', endDate: '',
      repeatDays: t.includes('κάθε') ? [2, 4] : [], repeatEvery: 1, repeatUntil: '', location: '', notes: '',
    });
  }

  const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
  if (rpc && req.method === 'POST') {
    const claims = readJwt(req.headers.authorization);
    if (claims === 'expired') return reply(401, { code: 'PGRST301', message: 'JWT expired' });
    if (claims === 'invalid') return reply(401, { code: 'PGRST301', message: 'JWT invalid' });
    const r = await callRpc(rpc[1], body, claims);
    return reply(r.status, r.body);
  }
  reply(404, { message: 'not found' });
}).on('upgrade', upgrade).listen(API_PORT);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/js/config.js') && fs.existsSync(path.join(root, p))) {
    // The real config, pointed at this fake project.
    const real = fs.readFileSync(path.join(root, p), 'utf8')
      .replace(/SUPABASE_URL = '[^']*'/, `SUPABASE_URL = '${API}'`)
      .replace(/SUPABASE_ANON_KEY = '[^']*'/, `SUPABASE_ANON_KEY = '${ANON_KEY}'`);
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(real);
  }
  const file = path.join(root, p.endsWith('/') ? `${p}index.html` : p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(SITE_PORT);

console.log(`site http://localhost:${SITE_PORT}  api ${API}`);
