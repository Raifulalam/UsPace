const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src');

const bytes = (...a) => Uint8Array.from(a);
const text = (s, pad = 16) => Uint8Array.from([...Buffer.from(s, 'latin1'), ...new Array(pad).fill(0)]);
const ID = 'a'.repeat(24);
const KEY = `${'A'.repeat(43)}=`;
const desc = (over = {}) => ({ id: ID, key: KEY, mime: 'image/jpeg', size: 1000, ...over });

test('encryptedSize: header + plaintext + 17 bytes per chunk (at least one chunk)', () => {
  assert.equal(m.encryptedSize(0), 24 + 17);
  assert.equal(m.encryptedSize(1), 24 + 1 + 17);
  assert.equal(m.encryptedSize(m.CHUNK), 24 + m.CHUNK + 17);
  assert.equal(m.encryptedSize(m.CHUNK + 1), 24 + m.CHUNK + 1 + 34);
  assert.equal(m.encryptedSize(10, 4), 24 + 10 + 17 * 3);
});

test('sniffMime recognises allowed types by content', () => {
  assert.equal(m.sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0)), 'image/jpeg');
  assert.equal(m.sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png');
  assert.equal(m.sniffMime(text('GIF89a')), 'image/gif');
  assert.equal(m.sniffMime(Uint8Array.from([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(m.sniffMime(Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 0, 0])), 'video/mp4');
  assert.equal(m.sniffMime(Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypM4A '), 0, 0, 0, 0])), 'audio/mp4');
  assert.equal(m.sniffMime(Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 0, 0]), 'audio/mp4'), 'audio/mp4');
  assert.equal(m.sniffMime(text('OggS')), 'audio/ogg');
  assert.equal(m.sniffMime(text('ID3')), 'audio/mpeg');
  assert.equal(m.sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0), 'audio/webm'), 'audio/webm');
  assert.equal(m.sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0), 'video/webm'), 'video/webm');
});

test('sniffMime rejects dangerous or unsupported content, whatever the extension or declared type says', () => {
  const rejects = [
    text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), text('<!doctype html><script>'), text('<html>'),
    text('MZ'), bytes(0x7f, 0x45, 0x4c, 0x46, 0, 0), text('#!/bin/sh\n'), text('PK'), text('%PDF-1.7'),
    Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0]), // HEIC
    bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0), // EBML with no/unknown declared type
    bytes(), bytes(1, 2),
  ];
  for (const r of rejects) assert.equal(m.sniffMime(r, 'image/png'), null);
});

test('validateDescriptor accepts good descriptors and strips unknown fields', () => {
  const d = m.validateDescriptor(desc({ name: '../../evil<script>.jpg', w: 800, h: 600, extra: 'x', thumb: { id: ID, key: KEY, mime: 'image/jpeg', w: 320, h: 240 } }));
  assert.equal(d.name, '....evilscript.jpg'); // separators and angle brackets stripped, so no path traversal or markup
  assert.ok(!d.name.includes('/') && !d.name.includes('\\') && !d.name.includes('<'));
  assert.equal(d.extra, undefined);
  assert.equal(d.thumb.w, 320);
  assert.deepEqual(m.validateDescriptor(desc({ mime: 'audio/webm', voice: true, dur: 3.14159 })), { id: ID, key: KEY, mime: 'audio/webm', size: 1000, voice: true, dur: 3.1 });
});

test('validateDescriptor rejects bad ids, keys, mimes, sizes and dimensions', () => {
  for (const bad of [
    null, {}, desc({ id: 'xyz' }), desc({ id: ID.toUpperCase() }), desc({ key: 'short' }), desc({ key: 'A'.repeat(44) }),
    desc({ mime: 'image/svg+xml' }), desc({ mime: 'application/x-msdownload' }), desc({ size: -1 }), desc({ size: 1.5 }),
    desc({ size: m.LIMITS.image + 1 }), desc({ w: 0, h: 5 }), desc({ w: 5 }), desc({ mime: 'audio/webm', dur: -1 }), desc({ dur: Infinity }),
  ]) assert.equal(m.validateDescriptor(bad), null, JSON.stringify(bad)?.slice(0, 80));
});

test('invalid thumbnails are dropped, not trusted; voice flag only on audio', () => {
  assert.equal(m.validateDescriptor(desc({ thumb: { id: ID, key: KEY, mime: 'image/png', w: 1, h: 1 } })).thumb, undefined);
  assert.equal(m.validateDescriptor(desc({ voice: true })).voice, undefined);
});

test('validateMemoryPayload enforces what each memory type needs', () => {
  const photo = desc();
  assert.ok(m.validateMemoryPayload({ media: [photo], caption: 'us' }, 'photo'));
  assert.equal(m.validateMemoryPayload({ media: [desc({ mime: 'video/mp4' })] }, 'photo'), null); // wrong kind
  assert.equal(m.validateMemoryPayload({}, 'photo'), null);
  assert.ok(m.validateMemoryPayload({ media: [desc({ mime: 'audio/webm', voice: true })] }, 'voice'));
  assert.ok(m.validateMemoryPayload({ text: 'Dear you…', title: 'Letter' }, 'letter'));
  assert.equal(m.validateMemoryPayload({ title: 'x' }, 'letter'), null);
  assert.ok(m.validateMemoryPayload({ title: 'First date' }, 'date'));
  assert.equal(m.validateMemoryPayload({ caption: 'x' }, 'date'), null);
  assert.ok(m.validateMemoryPayload({ text: 'hi', from: 'Sam', sentAt: 1700000000000 }, 'message'));
  assert.equal(m.validateMemoryPayload({ text: 'x' }, 'nonsense'), null);
});

test('validateMemoryPayload rejects oversize/ill-typed fields and too much media', () => {
  assert.equal(m.validateMemoryPayload({ title: 'x'.repeat(121), media: [desc()] }, 'photo'), null);
  assert.equal(m.validateMemoryPayload({ text: 5 }, 'note'), null);
  assert.equal(m.validateMemoryPayload({ media: new Array(5).fill(desc()) }, 'photo'), null);
  assert.equal(m.validateMemoryPayload({ media: [desc(), { bogus: true }] }, 'photo'), null);
});

test('cursor round-trips and rejects garbage', () => {
  const c = m.encodeCursor(1700000000000, ID);
  assert.deepEqual(m.decodeCursor(c), { ms: 1700000000000, id: ID });
  assert.deepEqual(m.decodeCursor(m.encodeCursor(-5000, ID)), { ms: -5000, id: ID });
  for (const bad of [undefined, '', 'not base64!!', Buffer.from('1:xyz').toString('base64url'), 'a'.repeat(200), Buffer.from('1:2:3').toString('base64url')]) assert.equal(m.decodeCursor(bad), null);
});

test('formatBytes', () => {
  assert.equal(m.formatBytes(500), '500 B');
  assert.equal(m.formatBytes(2048), '2 KB');
  assert.equal(m.formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('groupByMonth groups consecutive items by UTC month', () => {
  const items = [{ d: '2024-03-20T00:00:00.000Z' }, { d: '2024-03-01' }, { d: '2024-02-28' }, { d: '2023-12-25' }, { d: '2024-03-02' }];
  const g = m.groupByMonth(items, (x) => x.d);
  assert.deepEqual(g.map((x) => [x.key, x.items.length]), [['2024-03', 2], ['2024-02', 1], ['2023-12', 1], ['2024-03', 1]]);
  assert.deepEqual(m.groupByMonth([], (x) => x), []);
});

test('matchesQuery: every word, ignoring case and accents', () => {
  assert.equal(m.matchesQuery(['Our first trip to Café Roma', 'sunny'], 'cafe ROMA'), true);
  assert.equal(m.matchesQuery(['Our first trip'], 'first paris'), false);
  assert.equal(m.matchesQuery([undefined, null, ''], 'x'), false);
  assert.equal(m.matchesQuery(['anything'], '   '), true);
});

test('mediaIdsOf lists files and thumbnails once; memoryTypeFor maps kinds', () => {
  const t = 'b'.repeat(24);
  assert.deepEqual(m.mediaIdsOf([desc({ thumb: { id: t, key: KEY, mime: 'image/jpeg', w: 1, h: 1 } }), desc({ id: t })]), [ID, t]);
  assert.deepEqual(m.mediaIdsOf(undefined), []);
  assert.equal(m.memoryTypeFor({ mime: 'image/png' }), 'photo');
  assert.equal(m.memoryTypeFor({ mime: 'video/mp4' }), 'video');
  assert.equal(m.memoryTypeFor({ mime: 'audio/webm' }), 'voice');
  assert.equal(m.memoryTypeFor({ mime: 'text/html' }), null);
});
