// Plain Node tests (no database needed): npm run test:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { LocalDiskStorage } = require('../src/storage/localDisk');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'couples-storage-'));
const store = new LocalDiskStorage(root);
const key = `${'a'.repeat(24)}/${'b'.repeat(24)}`;
const src = (...chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));
const read = async (k) => { const parts = []; for await (const c of store.createReadStream(k)) parts.push(c); return Buffer.concat(parts); };
const leftovers = () => fs.readdirSync(path.join(root, 'a'.repeat(24))).filter((f) => f.endsWith('.part'));

test('stores exactly the declared bytes and reads them back', async () => {
  assert.equal(await store.put(key, src('hello ', 'world'), 11), 11);
  assert.equal((await read(key)).toString(), 'hello world');
  assert.equal(await store.exists(key), true);
});

test('rejects an upload larger than declared and leaves nothing behind', async () => {
  const k = `${'a'.repeat(24)}/${'c'.repeat(24)}`;
  await assert.rejects(store.put(k, src('0123456789', 'EXTRA'), 10), { code: 'SIZE_EXCEEDED' });
  assert.equal(await store.exists(k), false);
  assert.deepEqual(leftovers(), []);
});

test('rejects an upload smaller than declared and leaves nothing behind', async () => {
  const k = `${'a'.repeat(24)}/${'d'.repeat(24)}`;
  await assert.rejects(store.put(k, src('short'), 10), { code: 'SIZE_MISMATCH' });
  assert.equal(await store.exists(k), false);
  assert.deepEqual(leftovers(), []);
});

test('a stream that errors midway leaves nothing behind', async () => {
  const k = `${'a'.repeat(24)}/${'e'.repeat(24)}`;
  const bad = new Readable({ read() { this.push(Buffer.from('abc')); this.destroy(new Error('connection lost')); } });
  await assert.rejects(store.put(k, bad, 100));
  assert.equal(await store.exists(k), false);
  assert.deepEqual(leftovers(), []);
});

test('an empty declared size accepts an empty body', async () => {
  const k = `${'a'.repeat(24)}/${'f'.repeat(24)}`;
  assert.equal(await store.put(k, src(), 0), 0);
  assert.equal((await read(k)).length, 0);
});

test('delete removes the file and is idempotent', async () => {
  await store.delete(key);
  await store.delete(key);
  assert.equal(await store.exists(key), false);
});

test('keys that could escape the storage root are refused', async () => {
  for (const bad of ['../etc/passwd', `${'a'.repeat(24)}/../../x`, `${'A'.repeat(24)}/${'b'.repeat(24)}`, `${'a'.repeat(24)}/${'b'.repeat(23)}`, '', null, `${'a'.repeat(24)}\\${'b'.repeat(24)}`]) {
    await assert.rejects(store.put(bad, src('x'), 1), /invalid storage key/);
    assert.throws(() => store.createReadStream(bad), /invalid storage key/);
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
