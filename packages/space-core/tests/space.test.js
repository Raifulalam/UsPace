const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src');

const day = (str) => Date.UTC(...str.split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));

test('days together and the next anniversary', () => {
  const a = s.anniversaryInfo('2024-03-15', day('2026-03-10'));
  assert.deepEqual({ t: a.daysTogether, n: a.daysToNext, y: a.years, today: a.isToday, d: a.nextDate }, { t: 725, n: 5, y: 2, today: false, d: '2026-03-15' });
  const same = s.anniversaryInfo('2024-03-15', day('2026-03-15'));
  assert.equal(same.isToday, true);
  assert.equal(same.daysToNext, 0);
  assert.equal(same.years, 2);
  const after = s.anniversaryInfo('2024-03-15', day('2026-03-16'));
  assert.equal(after.nextDate, '2027-03-15');
  assert.equal(after.daysToNext, 364);
  assert.equal(after.years, 3);
  assert.equal(s.anniversaryInfo('2026-01-01', day('2026-01-31')).daysTogether, 30);
});

test('Feb 29 anniversaries land on Feb 28 in non-leap years and Feb 29 in leap years', () => {
  assert.equal(s.anniversaryInfo('2020-02-29', day('2023-02-27')).nextDate, '2023-02-28');
  assert.equal(s.anniversaryInfo('2020-02-29', day('2023-02-27')).daysToNext, 1);
  assert.equal(s.anniversaryInfo('2020-02-29', day('2024-02-28')).nextDate, '2024-02-29');
  assert.equal(s.anniversaryInfo('2020-02-29', day('2024-02-28')).years, 4);
  assert.equal(s.anniversaryInfo('2020-02-29', day('2023-02-28')).isToday, true);
});

test('a date in the future counts down to that date', () => {
  const f = s.anniversaryInfo('2030-01-01', day('2026-01-01'));
  assert.equal(f.upcoming, true);
  assert.equal(f.daysToNext, 1461);
  assert.equal(f.years, 0);
  assert.ok(f.daysTogether < 0);
});

test('invalid dates are rejected', () => {
  for (const bad of ['', 'nope', '2024-13-01', '2024-02-30', '2023-02-29', '24-01-01', null, undefined]) assert.equal(s.anniversaryInfo(bad, day('2026-01-01')), null);
  assert.equal(s.isLeap(2000), true); assert.equal(s.isLeap(1900), false); assert.equal(s.isLeap(2024), true);
  assert.equal(s.localTodayMs(new Date(2026, 5, 7, 23, 59)), Date.UTC(2026, 5, 7)); // the user's calendar day, not UTC's
});

test('initials and avatar colours', () => {
  assert.equal(s.initialsOf('alex'), 'A');
  assert.equal(s.initialsOf('  alex   morgan '), 'AM');
  assert.equal(s.initialsOf('Mary Jane Watson'), 'MW');
  assert.equal(s.initialsOf('💜 Sam'), '💜S');
  assert.equal(s.initialsOf(''), '?');
  assert.equal(s.hueOf('alex'), s.hueOf('alex'));
  assert.notEqual(s.hueOf('alex'), s.hueOf('sam'));
  for (const n of ['a', 'zzzz', '💜']) assert.ok(s.hueOf(n) >= 0 && s.hueOf(n) < 360);
});

test('relative times', () => {
  const now = Date.UTC(2026, 0, 20, 12);
  assert.equal(s.formatRelative(now - 10_000, now), 'just now');
  assert.equal(s.formatRelative(now - 5 * 60_000, now), '5 min ago');
  assert.equal(s.formatRelative(now - 3 * 3600_000, now), '3 h ago');
  assert.equal(s.formatRelative(now - 26 * 3600_000, now), 'yesterday');
  assert.equal(s.formatRelative(now - 5 * 86400_000, now), '5 days ago');
  assert.equal(s.formatRelative(now - 30 * 86400_000, now), '2025-12-21');
  assert.equal(s.formatRelative(now + 5000, now), 'just now'); // clock skew never shows the future
});

test('date dividers follow the viewer’s time zone', () => {
  const items = [{ t: '2026-03-01T23:30:00.000Z' }, { t: '2026-03-02T00:10:00.000Z' }, { t: '2026-03-02T10:00:00.000Z' }];
  assert.deepEqual(s.groupByDay(items, (x) => x.t, 0).map((g) => [g.key, g.items.length]), [['2026-03-01', 1], ['2026-03-02', 2]]);
  assert.deepEqual(s.groupByDay(items, (x) => x.t, 120).map((g) => [g.key, g.items.length]), [['2026-03-02', 3]]); // UTC+2
  assert.deepEqual(s.groupByDay([], (x) => x, 0), []);
});

test('reactions, stickers and replies accept only what we allow', () => {
  assert.equal(s.validateReaction({ emoji: '❤️' }), '❤️');
  for (const bad of [null, {}, { emoji: 'x' }, { emoji: '<script>' }, { emoji: ['❤️'] }, { emoji: '❤️❤️' }, 'a', 5]) assert.equal(s.validateReaction(bad), null);
  assert.equal(s.validateSticker({ sticker: '💜' }), '💜');
  assert.equal(s.validateSticker({ sticker: 'hello' }), null);
  const id = '00000000-0000-4000-8000-000000000001';
  assert.equal(s.validateReplyTo(id), id);
  for (const bad of ['x', '', null, 5, `${id}extra`, { id }]) assert.equal(s.validateReplyTo(bad), null);
});

test('disappearing timer options', () => {
  assert.deepEqual(s.ALLOWED_TTL, [0, 3600, 86400, 604800, 2592000]);
  assert.equal(s.TTL_OPTIONS[0].label, 'Off');
});

test('"Seen" marks the newest of MY messages that the partner has read', () => {
  const m = (id, sender) => ({ id, senderId: sender });
  const list = [m('a1', 'me'), m('a2', 'them'), m('a3', 'me'), m('a4', 'me'), m('a5', 'them')];
  assert.equal(s.lastSeenMessageId(list, 'a4', 'me'), 'a4');
  assert.equal(s.lastSeenMessageId(list, 'a3', 'me'), 'a3');
  assert.equal(s.lastSeenMessageId(list, 'a2', 'me'), 'a1');
  assert.equal(s.lastSeenMessageId(list, 'a0', 'me'), null);
  assert.equal(s.lastSeenMessageId(list, null, 'me'), null);
  assert.equal(s.lastSeenMessageId([{ id: null, senderId: 'me' }], 'zz', 'me'), null); // unsent local messages never show "Seen"
});
