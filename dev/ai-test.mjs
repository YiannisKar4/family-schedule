// Checks the dictation Edge Function (supabase/functions/sched-ai/index.ts) with Supabase and Gemini
// played by a fake fetch. Usage: node --experimental-strip-types dev/ai-test.mjs
import assert from 'node:assert/strict';

const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'gem-key' };
let handler;
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
const { prompt, clean } = await import('../supabase/functions/sched-ai/index.ts');

const ask = { text: 'Ποδόσφαιρο ο Πάνος κάθε Τρίτη και Πέμπτη 6 με 7 και μισή', today: '2026-11-09',
  members: ['Γιάννης', 'Αθηνά', 'Πάνος', 'Νικόλας'], categories: ['Σχολείο', 'Ποδόσφαιρο', 'Άλλο'], titles: ['Γενέθλια'] };

const p = prompt(ask);
assert.match(p, /Δευτέρα 2026-11-09 \(σήμερα\)/);
assert.match(p, /Τρίτη 2026-11-10 \(αύριο\)/);
assert.match(p, /Κυριακή 2026-12-13/);
assert.match(p, /Γιάννης, Αθηνά, Πάνος, Νικόλας/);
assert.match(p, /μοιάζει στον ήχο/);
console.log('  ✓ prompt: names, categories and a dated calendar from today');

const c = clean({ category: 'Ποδόσφαιρο', title: 'x', members: ['Πάνος', 'Μαρία', 'Πάνος'], date: '2026-11-10', start: '6:00', end: '5:30',
  endDate: '2026-11-12', repeatDays: [4, 2, 9, 2], repeatEvery: 3, repeatUntil: '2026-01-01', location: ' Γήπεδο ', notes: '' }, ask);
assert.deepEqual(c, { category: 'Ποδόσφαιρο', title: 'x', members: ['Πάνος'], date: '2026-11-10', allDay: false, start: '06:00', end: '',
  endDate: '', repeatDays: [2, 4], repeatEvery: 1, repeatUntil: '', location: 'Γήπεδο', notes: '' });
const d = clean({ category: 'Κολύμβηση', date: 'αύριο', start: '', end: '10:00', endDate: '2026-11-11' }, ask);
assert.equal(d.category, ''); assert.equal(d.date, '2026-11-09'); assert.equal(d.allDay, true); assert.equal(d.end, ''); assert.equal(d.endDate, '2026-11-11');
console.log('  ✓ clean: only known names, real dates and times, consistent repeat');

let household = 'h1', gemini = null, geminiStatus = 200;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://sb.test/rest/v1/rpc/sched_household')) {
    if (init.headers.Authorization !== 'Bearer user-token') return new Response('{}', { status: 401 });
    return Response.json(household);
  }
  if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
    gemini = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    if (geminiStatus !== 200) return new Response('quota', { status: geminiStatus });
    const out = { category: 'Ποδόσφαιρο', title: '', members: ['Πάνος'], date: '2026-11-10', allDay: false, start: '18:00', end: '19:30',
      endDate: '', repeatDays: [2, 4], repeatEvery: 1, repeatUntil: '', location: '', notes: '' };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const call = (body, token = 'user-token') => handler(new Request('https://fn.test/sched-ai', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, apikey: 'anon', 'content-type': 'application/json' }, body: JSON.stringify(body) }));

assert.equal((await handler(new Request('https://fn.test/sched-ai', { method: 'OPTIONS' }))).status, 200);
assert.equal((await call(ask, 'stranger')).status, 401);
household = null;
assert.equal((await call(ask)).status, 401);
household = 'h1';
assert.equal(gemini, null, 'Gemini is not called for someone outside the family');
let res = await call(ask);
assert.equal(res.status, 200);
assert.deepEqual((await res.json()).repeatDays, [2, 4]);
assert.equal(gemini.headers['x-goog-api-key'], 'gem-key');
assert.match(gemini.url, /models\/gemini-flash-lite-latest:generateContent$/);
assert.equal(gemini.body.contents[0].parts[0].text, ask.text);
assert.equal(gemini.body.generationConfig.responseMimeType, 'application/json');
console.log('  ✓ the function: only family sign-ins, asks Gemini, returns the cleaned fields');

assert.equal((await call({ ...ask, text: '  ' })).status, 400);
geminiStatus = 429;
res = await call(ask);
assert.equal(res.status, 429);
assert.match((await res.json()).error, /όριο/);
delete env.GEMINI_API_KEY;
res = await call(ask);
assert.equal(res.status, 500);
assert.match((await res.json()).error, /GEMINI_API_KEY/);
console.log('  ✓ errors: nothing said, Gemini limit, missing key');
console.log('4 passed');
