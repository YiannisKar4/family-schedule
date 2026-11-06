// Tests the date maths in js/dates.js. Usage: node dev/expand-test.mjs
import assert from 'node:assert/strict';
import { expand, lanes, weekday, weekStart, monthGrid, addMonths, addDays } from '../js/dates.js';

let passed = 0;
const ok = (l) => { passed++; console.log('  ✓', l); };

assert.equal(weekday('2026-11-05'), 4);
assert.equal(weekday('2026-11-08'), 7);
assert.equal(weekStart('2026-11-08'), '2026-11-02');
assert.equal(addDays('2026-10-24', 2), '2026-10-26'); // across the clock change
assert.equal(addMonths('2026-12-15', 1), '2027-01-01');
const g = monthGrid('2026-11-05');
assert.equal(g.length, 42);
assert.equal(g[0], '2026-10-26');
ok('date helpers');

const fb = { id: 'f', title: 'Ποδόσφαιρο', date: '2026-11-03', endDate: '2026-11-03', start: '18:00', end: '19:30',
  repeatDays: [2, 4], repeatEvery: 1, repeatUntil: '2026-11-19', skips: ['2026-11-12'] };
let r = expand([fb], '2026-11-01', '2026-11-30').map((x) => x.date);
assert.deepEqual(r, ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-17', '2026-11-19']);
ok('weekly: weekdays, skips, until');

r = expand([{ ...fb, date: '2026-11-04', repeatUntil: null, skips: [] }], '2026-11-01', '2026-11-14').map((x) => x.date);
assert.deepEqual(r, ['2026-11-05', '2026-11-10', '2026-11-12'], 'starts on its first matching day, not before');
ok('weekly: nothing before the start date, no end');

r = expand([{ ...fb, repeatDays: [2], repeatEvery: 2, repeatUntil: null, skips: [] }], '2026-11-01', '2026-12-05').map((x) => x.date);
assert.deepEqual(r, ['2026-11-03', '2026-11-17', '2026-12-01']);
ok('every two weeks');

const trip = { id: 't', title: 'Εκδρομή', date: '2026-10-30', endDate: '2026-11-02', start: null, end: null, repeatDays: null };
r = expand([trip, fb], '2026-11-01', '2026-11-03');
assert.equal(r[0].event.id, 't');
assert.equal(r[0].allDay, true);
assert.equal(r.length, 2);
ok('all-day span overlapping the range, all-day first');

const L = lanes([
  { start: '18:00', end: '19:00' }, { start: '18:30', end: '19:30' }, { start: '19:00', end: '20:00' }, { start: '21:00', end: '22:00' },
]);
assert.deepEqual(L.map((x) => [x.lane, x.lanes]), [[0, 2], [1, 2], [0, 2], [0, 1]]);
ok('overlap lanes');

console.log(`${passed} passed`);
