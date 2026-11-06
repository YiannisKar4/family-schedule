// Tests supabase/schema.sql on an in-process PostgreSQL (PGlite), with Supabase's
// auth helpers stubbed. Usage: node dev/db-test.mjs [path/to/budget/supabase/schema.sql]
// With the budget schema given, it runs that first, like the real shared project.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url).pathname;
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

async function as(who, sql, params = []) {
  return db.transaction(async (tx) => {
    if (who) {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: '11111111-1111-4111-8111-111111111111', email: who })]);
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

if (budget) {
  const r = await rpc(A, 'api_read');
  assert.equal(r.ok, true);
  ok('budget api still works next to it');
}

console.log(`${passed} passed`);
