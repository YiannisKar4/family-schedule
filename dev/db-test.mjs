// Tests supabase/schema.sql on an in-process PostgreSQL (PGlite), with Supabase's
// auth helpers stubbed. Usage: node dev/db-test.mjs [path/to/budget/supabase/schema.sql]
// With the budget schema given, it runs that first, like the real shared project.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url).pathname;
const db = new PGlite();

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public revoke execute on functions from public;
`);

// As in Supabase, where Realtime reads this publication.
await db.exec('create publication supabase_realtime');

const budget = process.argv[2];
if (budget) await db.exec(fs.readFileSync(budget, 'utf8'));
await db.exec(fs.readFileSync(`${root}supabase/schema.sql`, 'utf8'));
await db.exec(fs.readFileSync(`${root}supabase/schema.sql`, 'utf8')); // must be re-runnable
if (budget) await db.exec(fs.readFileSync(budget, 'utf8')); // and the budget schema still re-runs after it

const H = '00000000-0000-4000-8000-000000000001';
await db.exec(`
  insert into households (id, name) values ('${H}', 'Test'), ('00000000-0000-4000-8000-000000000002', 'Other');
  insert into allowed_emails values ('a@example.com', '${H}'), ('b@example.com', '${H}'),
                                    ('other@example.com', '00000000-0000-4000-8000-000000000002');
`);

// Who is signed in: the email, and the user id (every email is the same user unless SUB is changed).
let SUB = '11111111-1111-4111-8111-111111111111';
async function as(who, sql, params = []) {
  return db.transaction(async (tx) => {
    if (who === 'service_role') {
      await tx.exec('set local role service_role');
    } else if (who) {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: SUB, email: who })]);
      await tx.exec('set local role authenticated');
    } else {
      await tx.exec('set local role anon');
    }
    return tx.query(sql, params);
  });
}
const rpc = async (who, fn, args = []) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  return (await as(who, `select ${fn}(${ph}) as r`, args)).rows[0].r;
};
const rejects = async (p, re, label) => {
  try { await p; } catch (e) { assert.match(String(e.message), re, label); return; }
  assert.fail(`${label}: expected an error`);
};
let passed = 0;
const ok = (label) => { passed++; console.log('  ✓', label); };
const A = 'a@example.com';
const read = (f = '2026-11-01', t = '2026-12-31', who = A) => rpc(who, 'api_sched_read', [f, t]);

// First read sets up categories.
let d = await read();
assert.equal(d.categories.length, 7);
assert.equal(d.members.length, 0);
ok('first read adds the starting categories');
d = await read();
assert.equal(d.categories.length, 7);
ok('second read does not add them again');

// Members
const m1 = (await rpc(A, 'api_sched_save_member', [{ name: 'Γιάννης', color: '#2A78D6' }])).id;
const m2 = (await rpc(A, 'api_sched_save_member', [{ name: 'Παιδί', color: '#1baf7a' }])).id;
await rejects(rpc(A, 'api_sched_save_member', [{ name: 'Παιδί', color: '#1baf7a' }]), /Υπάρχει ήδη/, 'duplicate member');
await rejects(rpc(A, 'api_sched_save_member', [{ name: 'X', color: 'red' }]), /χρώμα/, 'bad color');
await rpc(A, 'api_sched_save_member', [{ id: m2, name: 'Νίκος', color: '#1baf7a' }]);
await rpc(A, 'api_sched_order', ['members', [m2, m1]]);
d = await read();
assert.deepEqual(d.members.map((m) => m.name), ['Νίκος', 'Γιάννης']);
assert.equal(d.members[1].color, '#2a78d6');
ok('members: add, rename, order, validation');

// Photos
const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
await rpc(A, 'api_sched_member_photo', [m1, PIC]);
d = await read();
assert.equal(d.members.find((m) => m.id === m1).photo, PIC);
assert.equal(d.members.find((m) => m.id === m2).photo, null);
await rejects(rpc(A, 'api_sched_member_photo', [m1, 'javascript:alert(1)']), /φωτογραφία/, 'not an image');
await rejects(rpc(A, 'api_sched_member_photo', [m1, `data:image/jpeg;base64,${'A'.repeat(200001)}`]), /φωτογραφία/, 'too big');
await rejects(rpc('other@example.com', 'api_sched_member_photo', [m1, PIC]), /δεν βρέθηκε/, 'other household photo');
await rpc(A, 'api_sched_save_member', [{ id: m1, name: 'Γιάννης', color: '#2a78d6' }]);
assert.equal((await read()).members.find((m) => m.id === m1).photo, PIC, 'saving the name keeps the photo');
await rpc(A, 'api_sched_member_photo', [m1, '']);
assert.equal((await read()).members.find((m) => m.id === m1).photo, null);
ok('member photos: set, remove, validation, household only');

const school = d.categories.find((c) => c.name === 'Σχολείο').id;
const football = d.categories.find((c) => c.name === 'Ποδόσφαιρο').id;

// One-off, timed
const e1 = (await rpc(A, 'api_sched_add', [{ title: 'Γιατρός', date: '2026-11-10', start: '17:30', end: '18:15', members: [m1] }])).id;
// Timed with no end gets one hour.
const e2 = (await rpc(A, 'api_sched_add', [{ title: 'Κλήση', date: '2026-11-11', start: '9:00' }])).id;
// All-day, two days
await rpc(A, 'api_sched_add', [{ title: 'Εκδρομή', date: '2026-11-20', endDate: '2026-11-21' }]);
// Weekly football Tue/Thu until mid-December
const fb = (await rpc(A, 'api_sched_add', [{ title: 'Ποδόσφαιρο', category: football, members: [m2], date: '2026-11-03',
  start: '18:00', end: '19:30', repeatDays: [2, 4], repeatUntil: '2026-12-17', location: 'Γήπεδο' }])).id;
d = await read();
const byId = (id) => d.events.find((e) => e.id === id);
assert.equal(byId(e2).end, '10:00');
assert.deepEqual(byId(fb).repeatDays, [2, 4]);
assert.equal(byId(fb).location, 'Γήπεδο');
ok('add: one-off, default one hour, all-day span, weekly series');

await rejects(rpc(A, 'api_sched_add', [{ title: '', date: '2026-11-10' }]), /τίτλο/, 'no title');
await rejects(rpc(A, 'api_sched_add', [{ title: 'x', date: '2026-11-10', start: '10:00', end: '09:00' }]), /μετά/, 'end before start');
await rejects(rpc(A, 'api_sched_add', [{ title: 'x', date: '10/11/2026' }]), /ημερομηνία/, 'bad date');
await rejects(rpc(A, 'api_sched_add', [{ title: 'x', date: '2026-11-10', members: [999] }]), /μέλος/, 'unknown member');
await rejects(rpc(A, 'api_sched_add', [{ title: 'x', date: '2026-11-10', repeatDays: [8] }]), /επανάληψης/, 'bad weekday');
ok('add: validation messages');

// Range: football series shows in a later range, the doctor does not.
d = await read('2026-12-01', '2026-12-31');
assert.ok(byId(fb));
assert.ok(!byId(e1));
d = await read('2027-01-01', '2027-01-31');
assert.ok(!byId(fb), 'series ended before January');
ok('read returns only events that can appear in the range');

// Only this one: Thursday 12 Nov moves to 19:00
const child = (await rpc(A, 'api_sched_update', [fb, { title: 'Ποδόσφαιρο', category: football, members: [m2], date: '2026-11-12',
  start: '19:00', end: '20:00' }, 'one', '2026-11-12'])).id;
d = await read();
assert.deepEqual(byId(fb).skips, ['2026-11-12']);
assert.equal(byId(child).parent, fb);
assert.equal(byId(child).repeatDays, null);
ok('edit only one date: the series skips it and a single event replaces it');

// Cancel one: Tuesday 17 Nov
await rpc(A, 'api_sched_delete', [fb, 'one', '2026-11-17']);
// This and following, from 1 Dec: new time and the old skip/child after that date move along
await rpc(A, 'api_sched_delete', [fb, 'one', '2026-12-08']);
const fb2 = (await rpc(A, 'api_sched_update', [fb, { title: 'Ποδόσφαιρο', category: football, members: [m2], date: '2026-11-03',
  start: '17:00', end: '18:30', repeatDays: [2, 4], repeatUntil: '2026-12-17' }, 'following', '2026-12-01'])).id;
d = await read();
assert.equal(byId(fb).repeatUntil, '2026-11-30');
assert.deepEqual(byId(fb).skips, ['2026-11-12', '2026-11-17']);
assert.equal(byId(fb2).date, '2026-12-01');
assert.equal(byId(fb2).start, '17:00');
assert.deepEqual(byId(fb2).skips, ['2026-12-08']);
assert.equal(byId(child).parent, fb);
ok('edit this and following: series splits, later skips move to the new part');

// Whole series
await rpc(A, 'api_sched_update', [fb2, { title: 'Ποδόσφαιρο U10', category: football, members: [m2], date: '2026-12-01',
  start: '17:00', end: '18:30', repeatDays: [2], repeatUntil: '2026-12-17' }, 'all', null]);
d = await read();
assert.equal(byId(fb2).title, 'Ποδόσφαιρο U10');
assert.deepEqual(byId(fb2).repeatDays, [2]);
ok('edit all of a series');

// Cancelled: one date of a series, then back again
const off1 = (await rpc(A, 'api_sched_update', [fb, { title: 'Ποδόσφαιρο', category: football, date: '2026-11-19', start: '17:00', end: '18:30', cancelled: true }, 'one', '2026-11-19'])).id;
d = await read();
assert.equal(byId(off1).cancelled, true);
assert.equal(byId(fb).cancelled, false);
await rpc(A, 'api_sched_update', [off1, { title: 'Ποδόσφαιρο', category: football, date: '2026-11-19', start: '17:00', end: '18:30', cancelled: false }]);
d = await read();
assert.equal(byId(off1).cancelled, false);
ok('cancelled: one date of a series, and undone');

// Delete following from 24 Nov removes the edited single dates after it as well
const child2 = (await rpc(A, 'api_sched_update', [fb, { title: 'Ποδόσφαιρο', date: '2026-11-26', start: '19:00', end: '20:00' }, 'one', '2026-11-26'])).id;
await rpc(A, 'api_sched_delete', [fb, 'following', '2026-11-24']);
d = await read();
assert.equal(byId(fb).repeatUntil, '2026-11-23');
assert.ok(!byId(child2));
assert.ok(byId(child));
ok('delete this and following');

// Delete all removes the edited single dates too
await rpc(A, 'api_sched_delete', [fb, 'all', null]);
d = await read();
assert.ok(!byId(fb) && !byId(child));
await rpc(A, 'api_sched_delete', [e1]);
await rejects(rpc(A, 'api_sched_delete', [e1]), /δεν βρέθηκε/, 'already deleted');
ok('delete all, delete single');

// Titles for quick add
d = await read();
assert.ok(d.titles.some((t) => t.title === 'Ποδόσφαιρο U10' && t.start === '17:00'));
ok('read returns past titles with their usual details');

// School weekly with no end date shows far ahead
const sc = (await rpc(A, 'api_sched_add', [{ title: 'Σχολείο', category: school, date: '2026-09-11', start: '08:15', end: '13:30', repeatDays: [1, 2, 3, 4, 5] }])).id;
d = await read('2027-05-01', '2027-05-31');
assert.ok(byId(sc));
ok('a series with no end shows in any later range');

// Second person in the household sees the same; others see nothing
d = await read(undefined, undefined, 'b@example.com');
assert.ok(byId(sc));
d = await read(undefined, undefined, 'other@example.com');
assert.equal(d.events.length, 0);
assert.ok(!d.members.length);
await rejects(rpc('other@example.com', 'api_sched_delete', [sc]), /δεν βρέθηκε/, 'other household delete');
await rejects(rpc('stranger@example.com', 'api_sched_read', ['2026-11-01', '2026-11-30']), /unauthorized/, 'not allowed');
await rejects(rpc(null, 'api_sched_read', ['2026-11-01', '2026-11-30']), /permission denied/, 'anon');
await rejects(as(A, 'select * from sched_events where household_id <> $1', [H]).then((r) => { if (r.rows.length) throw new Error('leak'); throw new Error('permission denied (none visible)'); }), /permission denied/, 'rls');
ok('security: household only, strangers and visitors get nothing');

const pub = (await db.query(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`)).rows.map((r) => r.tablename);
assert.deepEqual(pub, ['sched_categories', 'sched_events', 'sched_members', 'sched_skips']);
ok('live updates: the schedule tables are in the Realtime publication');


// ---- push notifications
const SVC = 'service_role';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const asUser = async (sub, fn) => { const keep = SUB; SUB = sub; try { return await fn(); } finally { SUB = keep; } };
const due = async (at) => (await as(SVC, 'select sched_push_due($1) as r', [at])).rows[0].r;
const devA = { endpoint: 'https://push.example/a', p256dh: 'pa', auth: 'aa' };
const devB = { endpoint: 'https://push.example/b', p256dh: 'pb', auth: 'ab' };

assert.equal((await rpc(A, 'api_sched_push_key')).key, null);
const cfg = (await as(SVC, `select sched_push_set_keys('PUB', '{"k":1}') as r`)).rows[0].r;
assert.equal(cfg.vapidPublic, 'PUB');
assert.ok(cfg.cronSecret.length >= 32);
await as(SVC, `select sched_push_set_keys('OTHER', '{}')`);
assert.equal((await rpc(A, 'api_sched_push_key')).key, 'PUB');
ok('push: keys are made once and the public one reaches signed-in users');

await rejects(rpc(A, 'api_sched_push_save', [{ ...devA, members: [9999] }]), /Άγνωστο μέλος/, 'unknown member');
await rejects(rpc(A, 'api_sched_push_save', [{ endpoint: 'http://x', p256dh: 'p', auth: 'a' }]), /Μη έγκυρη/, 'bad endpoint');
await asUser(U1, () => rpc(A, 'api_sched_push_save', [devA]));
assert.deepEqual(await rpc(A, 'api_sched_push_get', [devA.endpoint]), { remindMinutes: 30, members: [], changes: true });
await asUser(U1, () => rpc(A, 'api_sched_push_save', [{ ...devA, members: [m2] }]));
await asUser(U1, () => rpc(A, 'api_sched_push_save', [devA])); // a key refresh keeps the choices
assert.deepEqual(await rpc(A, 'api_sched_push_get', [devA.endpoint]), { remindMinutes: 30, members: [m2], changes: true });
await asUser(U2, () => rpc('b@example.com', 'api_sched_push_save', [{ ...devB, remindMinutes: null }]));
assert.deepEqual(await rpc(A, 'api_sched_push_get', [devB.endpoint]), { remindMinutes: null, members: [], changes: true });
assert.equal(await rpc('other@example.com', 'api_sched_push_get', [devA.endpoint]), null);
ok('push: a device signs up with defaults, keeps its choices, other households cannot see it');

await due('2026-11-01 08:00+02'); // clears what the tests above queued
const ev = (x) => asUser(U1, async () => (await rpc(A, 'api_sched_add', [x])).id);
const kid = await ev({ title: 'Λογοθεραπεία', members: [m2], date: '2026-11-10', start: '17:00', end: '17:45', location: 'Κέντρο' });
const dad = await ev({ title: 'Δουλειά', members: [m1], date: '2026-11-10', start: '17:00', end: '18:00' });
const fam = await ev({ title: 'Τραπέζι', date: '2026-11-10', start: '17:10', end: '19:00' });
let out = await due('2026-11-10 08:00+02');
assert.ok(!out.some((m) => m.endpoint === devA.endpoint && m.tag.startsWith('c-')), 'not back to who made it');
out = out.filter((m) => m.endpoint === devB.endpoint);
assert.deepEqual(out.map((m) => m.title), ['Νέο: Λογοθεραπεία · Νίκος', 'Νέο: Δουλειά · Γιάννης', 'Νέο: Τραπέζι']);
assert.equal(out[0].title, 'Νέο: Λογοθεραπεία · Νίκος');
assert.equal(out[0].body, 'Τρίτη 10 Νοεμβρίου · 17:00–17:45 · Κέντρο');
assert.equal(out[0].date, '2026-11-10');
assert.deepEqual(await due('2026-11-10 08:00+02'), []);
ok('push: an addition goes to the other users, not back to who made it');

out = await due('2026-11-10 16:29+02');
assert.deepEqual(out, [], 'too early');
out = await due('2026-11-10 16:30:05+02');
assert.deepEqual(out.map((m) => [m.endpoint, m.title, m.body]),
  [[devA.endpoint, 'Λογοθεραπεία · Νίκος', 'Σε 30 λεπτά · 17:00–17:45 · Κέντρο']]);
assert.deepEqual(await due('2026-11-10 16:31+02'), [], 'sent once');
out = await due('2026-11-10 16:41+02');
assert.deepEqual(out.map((m) => [m.title, m.body]), [['Τραπέζι', 'Σε 29 λεπτά · 17:10–19:00']], 'family events always');
assert.deepEqual(await due('2026-11-10 17:05+02'), [], 'nothing after the start');
ok('push: reminders before the start, once, only for the picked people and family ones');

// A series every 2 weeks on Tue and Thu from Tue 3 Nov, skipping Thu 12 Nov; a cancelled one never reminds.
await asUser(U1, () => rpc(A, 'api_sched_push_save', [{ ...devA, members: [], remindMinutes: 60, changes: false }]));
const ser = await ev({ title: 'Ποδόσφαιρο', members: [m2], date: '2026-11-03', start: '18:00', end: '19:00', repeatDays: [2, 4], repeatEvery: 2 });
await asUser(U1, () => rpc(A, 'api_sched_delete', [ser, 'one', '2026-11-19']));
await ev({ title: 'Γιατρός', date: '2026-11-17', start: '18:00', end: '18:30', cancelled: true });
await due('2026-11-01 08:00+02');
const at = async (t) => (await due(t)).filter((m) => m.endpoint === devA.endpoint).map((m) => `${m.title}|${m.body}`);
assert.deepEqual(await at('2026-11-05 17:00+02'), ['Ποδόσφαιρο · Νίκος|Σε 1 ώρα · 18:00–19:00']);
assert.deepEqual(await at('2026-11-10 17:00+02'), [], 'off week');
assert.deepEqual(await at('2026-11-17 17:00+02'), ['Ποδόσφαιρο · Νίκος|Σε 1 ώρα · 18:00–19:00'], 'on week; cancelled one silent');
assert.deepEqual(await at('2026-11-19 17:00+02'), [], 'skipped date');
ok('push: weekly series (every 2 weeks, skips) and cancelled activities');

// Change texts
await due('2026-11-01 08:00+02');
await asUser(U1, () => rpc(A, 'api_sched_update', [kid, { title: 'Λογοθεραπεία', members: [m2], date: '2026-11-10', start: '17:00', end: '17:45', cancelled: true }]));
await asUser(U1, () => rpc(A, 'api_sched_update', [ser, { title: 'Ποδόσφαιρο', members: [m2], date: '2026-11-03', start: '18:30', end: '19:30', repeatDays: [2, 4], repeatEvery: 2 }, 'following', '2026-11-17']));
await asUser(U1, () => rpc(A, 'api_sched_delete', [dad]));
out = (await due('2026-11-01 08:00+02')).filter((m) => m.endpoint === devB.endpoint).map((m) => `${m.title}|${m.body}`);
assert.deepEqual(out, [
  'Ακυρώθηκε: Λογοθεραπεία · Νίκος|Τρίτη 10 Νοεμβρίου · 17:00–17:45',
  'Αλλαγή: Ποδόσφαιρο · Νίκος|Από Τρίτη 17 Νοεμβρίου, κάθε 2 εβδομάδες: Τρι, Πεμ · 18:30–19:30',
  'Διαγραφή: Δουλειά · Γιάννης|Τρίτη 10 Νοεμβρίου · 17:00–18:00',
]);
ok('push: change, cancel and delete texts');

// Whose picture: children first, random between two; adults otherwise; nobody or everyone: the logo.
const kids = [];
for (const name of ['Παιδί Α', 'Παιδί Β']) kids.push((await rpc(A, 'api_sched_save_member', [{ name, color: '#eda100' }])).id);
await db.exec(`update sched_members set child = true where name like 'Παιδί %'`);
const all = (await db.query(`select array_agg(id) a from sched_members where household_id = '${H}' and not archived`)).rows[0].a;
const who = async (ids) => (await db.query(`select _sched_push_who('${H}', $1::smallint[]) as r`, [ids])).rows[0].r;
assert.equal(await who([]), null, 'nobody');
assert.equal(await who(all), null, 'whole family');
assert.equal((await who([m1, kids[0]])).id, kids[0], 'the child over the parent');
assert.deepEqual(await who([m1]), { id: m1, name: 'Γιάννης', color: '#2a78d6', photo: false });
const seen = new Set();
for (let i = 0; i < 40; i++) seen.add((await who([m2, ...kids])).id);
assert.deepEqual([...seen].sort(), [...kids].sort(), 'random between the two children, never a parent');
seen.clear();
for (let i = 0; i < 40; i++) seen.add((await who([m1, m2])).id);
assert.equal(seen.size, 2, 'random between two without children');
await asUser(U2, () => rpc('b@example.com', 'api_sched_push_save', [{ ...devB, remindMinutes: null, members: [], changes: true }]));
await due('2026-11-01 08:00+02');
await asUser(U1, () => rpc(A, 'api_sched_add', [{ title: 'Σχολείο', members: [m1, kids[1]], date: '2026-11-11', start: '08:00', end: '13:00' }]));
out = (await due('2026-11-01 08:00+02')).filter((m) => m.endpoint === devB.endpoint);
assert.equal(out[0].who.id, kids[1]);
ok('push: picture and colour of the child, else the person, else the logo');

await as(SVC, 'select sched_push_gone($1)', [[devB.endpoint]]);
assert.equal(await rpc(A, 'api_sched_push_get', [devB.endpoint]), null);
await rpc(A, 'api_sched_push_remove', [devA.endpoint]);
assert.equal(await rpc(A, 'api_sched_push_get', [devA.endpoint]), null);
await rejects(rpc(A, 'sched_push_due'), /permission denied/, 'users cannot run the sender');
await rejects(rpc(A, 'sched_push_config_get'), /permission denied/, 'users cannot read the secrets');
await rejects(as(A, 'select * from sched_push_subs'), /permission denied/, 'no direct table access');
await rejects(rpc(null, 'api_sched_push_key'), /permission denied/, 'anon');
ok('push: devices removed, sender and secrets closed to users');

if (budget) {
  const r = await rpc(A, 'api_read');
  assert.equal(r.ok, true);
  ok('budget api still works next to it');
}

console.log(`${passed} passed`);
