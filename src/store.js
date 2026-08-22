'use strict';
// ============================================================================
// chunked-upload-kit — core store (framework-agnostic, zero deps)
// ----------------------------------------------------------------------------
// A session = one directory `{dir}/{uploadId}/` holding `meta.json` plus one
// `{index}.part` file per received chunk. Everything is derived from disk so a
// process restart never loses an in-flight upload (resume just works).
// ============================================================================

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MB = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const MAX_META_BYTES = 16 * 1024;
// C0 control chars + DEL, built without escapes so no editor/tool can mangle them
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']', 'g');
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

class ChunkError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ChunkError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  toJSON() {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

const isInt = (n) => Number.isInteger(n);
const normOwner = (o) => (o === undefined || o === null ? null : String(o));

// Last path segment only, no control chars, no leading dots (so `..`/`.` and
// dotfiles are out), no Windows-illegal chars, no reserved device names, no
// trailing dots/spaces. Safe to path.join() under a directory you control.
function sanitizeFilename(name) {
  if (typeof name !== 'string') return '';
  let base = name.split(/[\\/]/).pop() || '';
  base = base
    .replace(CONTROL_CHARS, '')
    .replace(/^\.+/, '')
    .replace(/[:*?"<>|]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 255);
  if (WIN_RESERVED.test(base)) base = `_${base}`;
  return base;
}

function createChunkStore(opts = {}) {
  if (!opts.dir) throw new Error('createChunkStore: `dir` is required');
  const dir = path.resolve(opts.dir);
  const defaultChunkSize = opts.defaultChunkSize ?? 16 * MB;
  const maxChunkSize = opts.maxChunkSize ?? 32 * MB;
  const minChunkSize = opts.minChunkSize ?? 1024;
  const maxFileSize = opts.maxFileSize ?? 2 * 1024 * MB;
  const maxChunks = opts.maxChunks ?? 4096;
  const maxSessionsPerOwner = opts.maxSessionsPerOwner ?? 16;
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const log = opts.log || (() => {});

  if (defaultChunkSize > maxChunkSize) throw new Error('defaultChunkSize must be <= maxChunkSize');

  fs.mkdirSync(dir, { recursive: true });

  // uploadId → meta. Disk is the truth; this is a cache plus the in-memory
  // `received` set (so chunk PUTs don't readdir on every call).
  const sessions = new Map();
  const completing = new Map(); // uploadId → in-flight complete() promise
  let indexed = false; // have we scanned the dir once (for per-owner counts)?

  const sessionDir = (id) => path.join(dir, id);
  const partPath = (id, i) => path.join(sessionDir(id), `${i}.part`);

  async function readMeta(id) {
    try {
      const raw = await fsp.readFile(path.join(sessionDir(id), 'meta.json'), 'utf8');
      const meta = JSON.parse(raw);
      if (meta && meta.uploadId === id) return meta;
    } catch (_) { /* missing or corrupt → not found */ }
    return null;
  }

  async function scanReceived(meta) {
    let names;
    try {
      names = await fsp.readdir(sessionDir(meta.uploadId));
    } catch (_) {
      return new Set();
    }
    const set = new Set();
    for (const n of names) {
      const m = /^(\d+)\.part$/.exec(n);
      if (m && Number(m[1]) < meta.totalChunks) set.add(Number(m[1]));
    }
    return set;
  }

  async function receivedSet(meta) {
    if (!meta._received) meta._received = await scanReceived(meta);
    return meta._received;
  }

  const receivedList = async (meta) => [...(await receivedSet(meta))].sort((a, b) => a - b);

  // Load every session dir once so per-owner limits are right after a restart.
  async function ensureIndexed() {
    if (indexed) return;
    indexed = true;
    let names = [];
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) { /* empty */ }
    for (const ent of names) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name) || sessions.has(ent.name)) continue;
      const meta = await readMeta(ent.name);
      if (meta) sessions.set(ent.name, meta);
    }
  }

  function countForOwner(owner) {
    let n = 0;
    for (const m of sessions.values()) if (m.owner === owner) n++;
    return n;
  }

  async function load(id, owner) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new ChunkError(404, 'not_found', 'Upload session not found');
    let meta = sessions.get(id);
    if (!meta) {
      meta = await readMeta(id);
      if (!meta) throw new ChunkError(404, 'not_found', 'Upload session not found');
      sessions.set(id, meta);
    }
    if (meta.owner !== normOwner(owner)) throw new ChunkError(403, 'forbidden', 'Upload session belongs to someone else');
    return meta;
  }

  async function destroy(id) {
    sessions.delete(id);
    await fsp.rm(sessionDir(id), { recursive: true, force: true });
  }

  function expectedLength(meta, index) {
    return index < meta.totalChunks - 1 ? meta.chunkSize : meta.size - meta.chunkSize * (meta.totalChunks - 1);
  }

  function publicStatus(meta, rec) {
    return {
      uploadId: meta.uploadId,
      filename: meta.filename,
      size: meta.size,
      mime: meta.mime,
      chunkSize: meta.chunkSize,
      totalChunks: meta.totalChunks,
      received: rec,
    };
  }

  // Persisted form of a session (drop in-memory-only fields).
  const serialize = (meta) => {
    const { _received, ...rest } = meta;
    return JSON.stringify(rest);
  };

  // ── API ──────────────────────────────────────────────────────────────────

  async function init(input = {}, owner) {
    const filename = sanitizeFilename(input.filename);
    if (!filename) throw new ChunkError(400, 'bad_filename', 'filename is required');

    const size = input.size;
    if (!isInt(size) || size <= 0) throw new ChunkError(400, 'bad_size', 'size must be a positive integer');
    if (size > maxFileSize) throw new ChunkError(413, 'too_large', `File exceeds the ${maxFileSize} byte limit`, { maxFileSize });

    const chunkSize = input.chunkSize ?? Math.min(defaultChunkSize, maxChunkSize);
    if (!isInt(chunkSize) || chunkSize < minChunkSize || chunkSize > maxChunkSize) {
      throw new ChunkError(400, 'bad_chunk_size', `chunkSize must be an integer between ${minChunkSize} and ${maxChunkSize}`, { maxChunkSize });
    }

    const totalChunks = Math.ceil(size / chunkSize);
    if (totalChunks > maxChunks) {
      throw new ChunkError(400, 'too_many_chunks', `File would need ${totalChunks} chunks (max ${maxChunks}); use a larger chunkSize`, { maxChunks });
    }

    let sha256 = null;
    if (input.sha256 !== undefined && input.sha256 !== null) {
      if (typeof input.sha256 !== 'string' || !SHA256_RE.test(input.sha256)) throw new ChunkError(400, 'bad_sha256', 'sha256 must be a 64-char hex string');
      sha256 = input.sha256.toLowerCase();
    }

    let meta = null;
    if (input.meta !== undefined && input.meta !== null) {
      if (typeof input.meta !== 'object' || Array.isArray(input.meta)) throw new ChunkError(400, 'bad_meta', 'meta must be a plain object');
      const json = JSON.stringify(input.meta);
      if (Buffer.byteLength(json) > MAX_META_BYTES) throw new ChunkError(400, 'bad_meta', `meta exceeds ${MAX_META_BYTES} bytes`);
      meta = JSON.parse(json);
    }

    const mime = typeof input.mime === 'string' && input.mime.length > 0 && input.mime.length <= 255
      ? input.mime
      : 'application/octet-stream';

    const ownerKey = normOwner(owner);
    await ensureIndexed();
    if (countForOwner(ownerKey) >= maxSessionsPerOwner) {
      throw new ChunkError(429, 'too_many_sessions', `Too many uploads in progress (max ${maxSessionsPerOwner}); finish or abort one first`, { maxSessionsPerOwner });
    }

    const uploadId = crypto.randomBytes(16).toString('base64url');
    const session = {
      uploadId,
      filename,
      size,
      mime,
      chunkSize,
      totalChunks,
      sha256,
      meta,
      owner: ownerKey,
      createdAt: Date.now(),
      _received: new Set(),
    };
    await fsp.mkdir(sessionDir(uploadId), { recursive: true });
    await fsp.writeFile(path.join(sessionDir(uploadId), 'meta.json'), serialize(session));
    sessions.set(uploadId, session);
    return { uploadId, chunkSize, totalChunks, received: [] };
  }

  async function status(id, owner) {
    const meta = await load(id, owner);
    return publicStatus(meta, await receivedList(meta));
  }

  // `source` is a Buffer or a Readable. `hint.length` (e.g. Content-Length) lets
  // us fail before reading anything when the caller already knows it is wrong.
  async function putChunk(id, index, source, owner, hint = {}) {
    const meta = await load(id, owner);
    if (completing.has(id)) throw new ChunkError(409, 'completing', 'Upload is already being finalized');
    const i = typeof index === 'string' && /^\d+$/.test(index) ? Number(index) : index;
    if (!isInt(i) || i < 0 || i >= meta.totalChunks) {
      throw new ChunkError(400, 'bad_index', `index must be an integer between 0 and ${meta.totalChunks - 1}`);
    }
    const expected = expectedLength(meta, i);
    if (isInt(hint.length) && hint.length !== expected) {
      throw new ChunkError(400, 'bad_chunk_length', `Chunk ${i} must be ${expected} bytes, got ${hint.length}`, { expected, index: i });
    }

    const stream = Buffer.isBuffer(source) ? Readable.from([source]) : source;
    if (!stream || typeof stream.pipe !== 'function') throw new ChunkError(400, 'bad_chunk', 'Chunk body must be a Buffer or a Readable');

    const tmp = `${partPath(id, i)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let seen = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > expected) {
          cb(new ChunkError(400, 'bad_chunk_length', `Chunk ${i} must be ${expected} bytes, got more`, { expected, index: i }));
          return;
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(stream, counter, fs.createWriteStream(tmp));
      if (seen !== expected) {
        throw new ChunkError(400, 'bad_chunk_length', `Chunk ${i} must be ${expected} bytes, got ${seen}`, { expected, index: i });
      }
      await fsp.rename(tmp, partPath(id, i));
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if (typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy();
      throw err;
    }

    const set = await receivedSet(meta);
    set.add(i);
    return { received: [...set].sort((a, b) => a - b), done: set.size === meta.totalChunks };
  }

  // Single-flight per uploadId: a retried /complete (proxy 5xx, client timeout)
  // joins the in-flight assembly instead of racing it.
  function complete(id, owner) {
    const key = typeof id === 'string' ? id : '';
    const inflight = completing.get(key);
    if (inflight) {
      return inflight.then((res) => {
        // still enforce ownership for the joining caller
        if (res.owner !== normOwner(owner)) throw new ChunkError(403, 'forbidden', 'Upload session belongs to someone else');
        return res;
      });
    }
    const p = doComplete(id, owner).finally(() => completing.delete(key));
    if (key) completing.set(key, p);
    return p;
  }

  async function doComplete(id, owner) {
    const meta = await load(id, owner);
    const rec = await receivedSet(meta);
    if (rec.size !== meta.totalChunks) {
      const missing = [];
      for (let i = 0; i < meta.totalChunks; i++) if (!rec.has(i)) missing.push(i);
      throw new ChunkError(409, 'missing_chunks', `${missing.length} chunk(s) still missing`, { missing, received: [...rec].sort((a, b) => a - b) });
    }

    const assembled = path.join(sessionDir(id), 'assembled');
    const tmp = `${assembled}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const hash = crypto.createHash('sha256');
    const hasher = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const parts = async function* () {
      for (let i = 0; i < meta.totalChunks; i++) {
        yield* fs.createReadStream(partPath(id, i));
      }
    };
    try {
      await pipeline(Readable.from(parts()), hasher, fs.createWriteStream(tmp));
      await fsp.rename(tmp, assembled);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }

    const st = await fsp.stat(assembled);
    const sha256 = hash.digest('hex');
    if (st.size !== meta.size) {
      await destroy(id);
      throw new ChunkError(500, 'assemble_failed', `Assembled ${st.size} bytes, expected ${meta.size}`);
    }
    if (meta.sha256 && meta.sha256 !== sha256) {
      await destroy(id);
      throw new ChunkError(422, 'hash_mismatch', 'Assembled file does not match the declared sha256', { expected: meta.sha256, actual: sha256 });
    }

    // drop the parts now — the assembled file is all the consumer needs
    await Promise.all(Array.from({ length: meta.totalChunks }, (_, i) => fsp.rm(partPath(id, i), { force: true })));

    return {
      uploadId: id,
      path: assembled,
      filename: meta.filename,
      mime: meta.mime,
      size: meta.size,
      sha256,
      meta: meta.meta,
      owner: meta.owner,
      release: () => destroy(id),
    };
  }

  async function abort(id, owner) {
    await load(id, owner);
    if (completing.has(id)) throw new ChunkError(409, 'completing', 'Upload is already being finalized');
    await destroy(id);
    return { ok: true };
  }

  async function sweep(now = Date.now()) {
    let names;
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return 0;
    }
    let removed = 0;
    for (const ent of names) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name)) continue;
      if (completing.has(ent.name)) continue;
      const meta = (await readMeta(ent.name)) || sessions.get(ent.name); // disk is the truth
      let createdAt = meta ? meta.createdAt : null;
      if (!isInt(createdAt)) {
        try { createdAt = (await fsp.stat(sessionDir(ent.name))).mtimeMs; } catch (_) { continue; }
      }
      if (now - createdAt > ttlMs) {
        try {
          await destroy(ent.name);
          removed++;
        } catch (err) {
          log(`sweep: failed to remove ${ent.name}: ${err.message}`);
        }
      }
    }
    return removed;
  }

  function startSweeper(intervalMs = 60 * 60 * 1000) {
    const run = () => sweep().then((n) => { if (n > 0) log(`sweep: removed ${n} expired upload session(s)`); }).catch((err) => log(`sweep failed: ${err.message}`));
    const boot = setTimeout(run, 5000);
    const timer = setInterval(run, intervalMs);
    boot.unref?.();
    timer.unref?.();
    return () => { clearTimeout(boot); clearInterval(timer); };
  }

  return {
    dir,
    limits: { defaultChunkSize, maxChunkSize, minChunkSize, maxFileSize, maxChunks, maxSessionsPerOwner, ttlMs },
    init,
    status,
    putChunk,
    complete,
    abort,
    sweep,
    startSweeper,
  };
}

exports.createChunkStore = createChunkStore;
exports.ChunkError = ChunkError;
exports.sanitizeFilename = sanitizeFilename;
