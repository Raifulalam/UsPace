const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stroke = (n, pts = [1, 1, 5, 5]) => ({ t: 'stroke', id: id(n), tool: 'pen', color: '#112233', size: 4, pts });
const E = (seq, senderId, op) => ({ seq, senderId, op });
const ids = (list) => list.map((d) => d.op.id);

test('ops apply in seq order regardless of arrival order', () => {
  const s = c.computeScene([E(3, 'b', stroke(3)), E(1, 'a', stroke(1)), E(2, 'a', stroke(2))]);
  assert.deepEqual(ids(s.visible), [id(1), id(2), id(3)]);
});

test('duplicate seq is ignored; pending (Infinity) ops sort last and are all kept', () => {
  const s = c.computeScene([E(1, 'a', stroke(1)), E(1, 'a', stroke(1)), E(Infinity, 'a', stroke(8)), E(Infinity, 'a', stroke(9))]);
  assert.deepEqual(ids(s.visible), [id(1), id(8), id(9)]);
});

test('undo hides own drawing, redo restores it', () => {
  const base = [E(1, 'a', stroke(1)), E(2, 'a', stroke(2))];
  const undone = c.computeScene([...base, E(3, 'a', { t: 'undo', target: id(2) })]);
  assert.deepEqual(ids(undone.visible), [id(1)]);
  assert.deepEqual(ids(undone.hidden), [id(2)]);
  const redone = c.computeScene([...base, E(3, 'a', { t: 'undo', target: id(2) }), E(4, 'a', { t: 'redo', target: id(2) })]);
  assert.deepEqual(ids(redone.visible), [id(1), id(2)]);
});

test("you cannot undo your partner's drawing", () => {
  const s = c.computeScene([E(1, 'a', stroke(1)), E(2, 'b', { t: 'undo', target: id(1) })]);
  assert.deepEqual(ids(s.visible), [id(1)]);
});

test('an undo that is ordered before its target still takes effect', () => {
  const s = c.computeScene([E(1, 'a', { t: 'undo', target: id(5) }), E(2, 'a', stroke(5))]);
  assert.deepEqual(ids(s.visible), []);
});

test('clear wipes earlier drawings only; later ones survive', () => {
  const s = c.computeScene([E(1, 'a', stroke(1)), E(2, 'b', stroke(2)), E(3, 'a', { t: 'clear' }), E(4, 'b', stroke(4))]);
  assert.deepEqual(ids(s.visible), [id(4)]);
});

test('last background wins', () => {
  const s = c.computeScene([E(1, 'a', { t: 'bg', color: '#000000', pattern: 'dots' }), E(2, 'b', { t: 'bg', color: '#ffffff', pattern: 'grid' })]);
  assert.deepEqual(s.bg, { color: '#ffffff', pattern: 'grid' });
});

test('undoCandidate / hiddenIdsBy only consider my own work', () => {
  const s = c.computeScene([E(1, 'a', stroke(1)), E(2, 'b', stroke(2)), E(3, 'a', { t: 'undo', target: id(1) })]);
  assert.equal(c.undoCandidate(s, 'a'), null);
  assert.equal(c.undoCandidate(s, 'b'), id(2));
  assert.deepEqual(c.hiddenIdsBy(s, 'a'), [id(1)]);
  assert.deepEqual(c.hiddenIdsBy(s, 'b'), []);
});

test('validateOp accepts good ops and clamps/rounds', () => {
  const ok = c.validateOp({ ...stroke(1, [1.4, 2.6, 5000, -900]), size: 500 });
  assert.equal(ok.size, 64);
  assert.deepEqual(ok.pts, [1, 3, 1050, -50]);
  assert.deepEqual(c.validateOp({ t: 'clear', extra: 1 }), { t: 'clear' });
  assert.equal(c.validateOp({ t: 'sticker', id: id(2), kind: 'heart', x: 10, y: 10, color: '#abcdef', size: 1 }).size, 16);
});

test('validateOp rejects malformed or hostile payloads', () => {
  const bad = [
    null, 'x', {}, { t: 'nope' },
    { ...stroke(1), id: 'not-a-uuid' }, { ...stroke(1), tool: 'laser' }, { ...stroke(1), color: 'red' },
    { ...stroke(1), pts: [1, 2, 3] }, { ...stroke(1), pts: [1, 'a'] }, { ...stroke(1), pts: new Array(3002).fill(1) },
    { ...stroke(1), pts: [NaN, 1] }, { ...stroke(1), size: Infinity },
    { t: 'text', id: id(1), text: '', x: 1, y: 1, color: '#000000', size: 20 },
    { t: 'text', id: id(1), text: 'x'.repeat(281), x: 1, y: 1, color: '#000000', size: 20 },
    { t: 'sticker', id: id(1), kind: 'skull', x: 1, y: 1, color: '#000000', size: 20 },
    { t: 'undo', target: 'x' }, { t: 'bg', color: '#000000', pattern: 'evil' },
  ];
  for (const b of bad) assert.equal(c.validateOp(b), null, JSON.stringify(b)?.slice(0, 80));
});

test('validateLive: strokes, text previews and limits', () => {
  assert.ok(c.validateLive({ k: 'stroke', sid: id(1), tool: 'pen', color: '#000000', size: 3, pts: [1, 2, 3, 4], start: true }));
  assert.ok(c.validateLive({ k: 'text', sid: id(1), text: '', x: 1, y: 1, color: '#000000', size: 20 })); // empty = remove preview
  assert.equal(c.validateLive({ k: 'stroke', sid: id(1), tool: 'pen', color: '#000000', size: 3, pts: new Array(402).fill(1) }), null);
  assert.equal(c.validateLive({ k: 'zzz', sid: id(1) }), null);
});
