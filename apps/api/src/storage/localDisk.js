const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

/** Passes bytes through while enforcing an EXACT total size, so a client can never store more (or less) than it reserved. */
class ExactSizeStream extends Transform {
  constructor(expected) {
    super();
    this.expected = expected;
    this.bytes = 0;
  }
  _transform(chunk, enc, cb) {
    this.bytes += chunk.length;
    if (this.bytes > this.expected) return cb(Object.assign(new Error('upload larger than declared'), { code: 'SIZE_EXCEEDED' }));
    cb(null, chunk);
  }
  _flush(cb) {
    if (this.bytes !== this.expected) return cb(Object.assign(new Error('upload smaller than declared'), { code: 'SIZE_MISMATCH' }));
    cb();
  }
}

/**
 * Private object storage on local disk. Keys are "<coupleId>/<assetId>" (24-hex each), validated strictly, so no
 * path can escape the root. Files are written to a temp name and renamed, so readers never see a partial file.
 * The S3-compatible driver (same interface: put/createReadStream/delete) is a deployment step.
 */
class LocalDiskStorage {
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
  }
  _path(key) {
    if (typeof key !== 'string' || !/^[a-f0-9]{24}\/[a-f0-9]{24}$/.test(key)) throw new Error('invalid storage key');
    return path.join(this.root, key.slice(0, 24), key.slice(25));
  }
  async put(key, readable, expectedBytes) {
    const dest = this._path(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${crypto.randomBytes(6).toString('hex')}.part`;
    const counter = new ExactSizeStream(expectedBytes);
    try {
      await pipeline(readable, counter, fs.createWriteStream(tmp, { flags: 'wx' }));
      await fsp.rename(tmp, dest);
      return counter.bytes;
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }
  createReadStream(key) {
    return fs.createReadStream(this._path(key));
  }
  async exists(key) {
    try { await fsp.access(this._path(key)); return true; } catch { return false; }
  }
  async delete(key) {
    await fsp.rm(this._path(key), { force: true });
  }
}

module.exports = { LocalDiskStorage, ExactSizeStream };
