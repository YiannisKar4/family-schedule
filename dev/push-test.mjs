// Checks the Edge Function's Web Push code (supabase/functions/sched-push/index.ts) against an
// independent implementation: a browser's side is played by Node's crypto and the http_ece package.
// Usage: node --experimental-strip-types dev/push-test.mjs
import crypto from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
import ece from 'http_ece';

// A stand-in for the Edge runtime: its env and Deno.serve, so the whole handler can run here.
const env = { SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
let handler;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
const { makeKeys, encrypt, vapidAuth, b64u, unb64u } = await import('../supabase/functions/sched-push/index.ts');

// The "browser": its own key pair and auth secret, as a PushSubscription would give them.
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const auth = crypto.randomBytes(16);
const p256dh = b64u(ua.getPublicKey());

const text = JSON.stringify({ title: 'Λογοθεραπεία · Πάνος', body: 'Σε 30 λεπτά · 17:00–17:45', date: '2026-11-10' });
const sealed = await encrypt(new TextEncoder().encode(text), p256dh, b64u(auth));
const opened = ece.decrypt(Buffer.from(sealed), { version: 'aes128gcm', privateKey: ua, authSecret: auth });
assert.equal(opened.toString('utf8'), text);
assert.equal(new DataView(sealed.buffer).getUint32(16), 4096);
console.log('  ✓ payload decrypts on the browser side (aes128gcm)');

const keys = await makeKeys();
assert.equal(unb64u(keys.publicKey).length, 65);
const header = await vapidAuth('https://web.push.apple.com/QGuQyavXutnMH2...', keys.publicKey, keys.privateKey);
const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
assert.ok(m, header);
assert.equal(m[4], keys.publicKey);
const claims = JSON.parse(Buffer.from(unb64u(m[2])).toString());
assert.equal(claims.aud, 'https://web.push.apple.com');
assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
assert.match(claims.sub, /^https:\/\//);
const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: keys.privateKey.x, y: keys.privateKey.y }, format: 'jwk' });
assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(unb64u(m[3]))));
console.log('  ✓ VAPID header is a valid ES256 token for the push service');

// The whole run: a fake database (REST rpc) and a fake push service, on one local server.
const cfg = { cronSecret: 'secret', vapidPublic: null, vapidPrivate: null };
const calls = [];
const received = [];
const server = http.createServer(async (req, res) => {
  let raw = [];
  for await (const c of req) raw.push(c);
  raw = Buffer.concat(raw);
  const url = new URL(req.url, 'http://x');
  const rpcName = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)?.[1];
  const json = (x) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
  if (rpcName) {
    assert.equal(req.headers.apikey, 'service-key');
    const args = raw.length ? JSON.parse(raw) : {};
    calls.push([rpcName, args]);
    if (rpcName === 'sched_push_config_get') return json(cfg);
    if (rpcName === 'sched_push_set_keys') { cfg.vapidPublic = args.public_key; cfg.vapidPrivate = args.private_key; return json(cfg); }
    if (rpcName === 'sched_push_due') {
      const to = (id) => ({ endpoint: `http://localhost:${server.address().port}/push/${id}`, p256dh, auth: b64u(auth), title: `T${id}`, body: 'B', date: '2026-11-10', tag: `t${id}` });
      return json([to('ok'), to('gone')]);
    }
    if (rpcName === 'sched_push_gone') { res.writeHead(204); return res.end(); }
  }
  if (url.pathname.startsWith('/push/')) {
    received.push({ id: url.pathname.slice(6), headers: req.headers, body: raw });
    res.writeHead(url.pathname.endsWith('gone') ? 410 : 201);
    return res.end();
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, r));
env.SUPABASE_URL = `http://localhost:${server.address().port}`;

let r = await handler(new Request('http://fn/', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } }));
assert.equal(r.status, 403);
assert.deepEqual(calls.map((c) => c[0]), ['sched_push_config_get']);
r = await handler(new Request('http://fn/', { method: 'POST', headers: { 'x-cron-secret': 'secret' } }));
assert.deepEqual(await r.json(), { sent: 1, gone: 1, failed: [] });
assert.ok(cfg.vapidPublic, 'keys made on the first run');
assert.deepEqual(calls.at(-1), ['sched_push_gone', { endpoints: [`http://localhost:${server.address().port}/push/gone`] }]);
const got = received.find((x) => x.id === 'ok');
assert.equal(got.headers['content-encoding'], 'aes128gcm');
assert.equal(got.headers.ttl, '3600');
assert.match(got.headers.authorization, new RegExp(`^vapid t=.+, k=${cfg.vapidPublic}$`));
assert.deepEqual(JSON.parse(ece.decrypt(got.body, { version: 'aes128gcm', privateKey: ua, authSecret: auth }).toString()),
  { title: 'Tok', body: 'B', date: '2026-11-10', tag: 'tok' });
const keysBefore = cfg.vapidPublic;
await handler(new Request('http://fn/', { method: 'POST', headers: { 'x-cron-secret': 'secret' } }));
assert.equal(cfg.vapidPublic, keysBefore, 'keys kept on later runs');
server.close();
console.log('  ✓ the function: checks the cron secret, makes keys once, sends, forgets gone devices');
