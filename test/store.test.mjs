import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { createChunkStore, ChunkError } from '../index.js'

const KB = 1024
let dir
let store

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-store-'))
  store = createChunkStore({ dir, defaultChunkSize: 4 * KB, maxChunkSize: 8 * KB, maxFileSize: 100 * KB, ttlMs: 60_000 })
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const rand = (n) => crypto.randomBytes(n)
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

async function rejects(p, status, code) {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof ChunkError, `expected ChunkError, got ${err?.constructor?.name}: ${err?.message}`)
    assert.equal(err.status, status)
    assert.equal(err.code, code)
    return true
  })
}

test('init validates input', async () => {
  await rejects(store.init({ filename: 'a.bin', size: 0 }, 'u1'), 400, 'bad_size')
  await rejects(store.init({ filename: 'a.bin', size: 200 * KB }, 'u1'), 413, 'too_large')
  await rejects(store.init({ filename: 'a.bin', size: 10, chunkSize: 16 * KB }, 'u1'), 400, 'bad_chunk_size')
  await rejects(store.init({ filename: '', size: 10 }, 'u1'), 400, 'bad_filename')
  await rejects(store.init({ filename: 'a.bin', size: 10, sha256: 'zz' }, 'u1'), 400, 'bad_sha256')
})

test('init strips path components from filename', async () => {
  const s = await store.init({ filename: '../../evil/name.mp4', size: 10 }, 'u1')
  const st = await store.status(s.uploadId, 'u1')
  assert.equal(st.filename, 'name.mp4')
})

test('full round trip: init → put → complete yields identical bytes + sha256', async () => {
  const data = rand(10 * KB + 123)
  const s = await store.init({ filename: 'v.mp4', size: data.length, mime: 'video/mp4', meta: { album: 'x' } }, 'u1')
  assert.equal(s.chunkSize, 4 * KB)
  assert.equal(s.totalChunks, 3)
  assert.deepEqual(s.received, [])

  for (let i = 0; i < s.totalChunks; i++) {
    const part = data.subarray(i * s.chunkSize, (i + 1) * s.chunkSize)
    const r = await store.putChunk(s.uploadId, i, i % 2 ? Readable.from([part]) : part, 'u1')
    assert.equal(r.done, i === s.totalChunks - 1)
  }
  const done = await store.complete(s.uploadId, 'u1')
  assert.equal(done.filename, 'v.mp4')
  assert.equal(done.mime, 'video/mp4')
  assert.equal(done.size, data.length)
  assert.equal(done.owner, 'u1')
  assert.deepEqual(done.meta, { album: 'x' })
  assert.equal(done.sha256, sha(data))
  assert.ok(Buffer.from(fs.readFileSync(done.path)).equals(data))
  await done.release()
  assert.ok(!fs.existsSync(path.join(dir, s.uploadId)))
  await rejects(store.status(s.uploadId, 'u1'), 404, 'not_found')
})

test('putChunk rejects wrong length, bad index, and re-put is idempotent', async () => {
  const data = rand(9 * KB)
  const s = await store.init({ filename: 'a.bin', size: data.length }, 'u1')
  await rejects(store.putChunk(s.uploadId, 0, data.subarray(0, 100), 'u1'), 400, 'bad_chunk_length')
  await rejects(store.putChunk(s.uploadId, 0, rand(5 * KB), 'u1'), 400, 'bad_chunk_length')
  await rejects(store.putChunk(s.uploadId, 0, Readable.from([rand(5 * KB)]), 'u1'), 400, 'bad_chunk_length')
  await rejects(store.putChunk(s.uploadId, 3, rand(KB), 'u1'), 400, 'bad_index')
  await rejects(store.putChunk(s.uploadId, -1, rand(KB), 'u1'), 400, 'bad_index')
  // last chunk is the remainder (1 KB)
  await rejects(store.putChunk(s.uploadId, 2, rand(4 * KB), 'u1'), 400, 'bad_chunk_length')
  await store.putChunk(s.uploadId, 2, data.subarray(8 * KB), 'u1')
  // failed puts must not leave a .part behind
  assert.ok(!fs.existsSync(path.join(dir, s.uploadId, '0.part')))
  const r1 = await store.putChunk(s.uploadId, 0, data.subarray(0, 4 * KB), 'u1')
  const r2 = await store.putChunk(s.uploadId, 0, data.subarray(0, 4 * KB), 'u1')
  assert.deepEqual(r1.received, [0, 2])
  assert.deepEqual(r2.received, [0, 2])
})

test('complete reports missing chunks (409) and does not consume the session', async () => {
  const data = rand(8 * KB)
  const s = await store.init({ filename: 'a.bin', size: data.length }, 'u1')
  await store.putChunk(s.uploadId, 1, data.subarray(4 * KB), 'u1')
  await assert.rejects(store.complete(s.uploadId, 'u1'), (err) => {
    assert.equal(err.status, 409)
    assert.equal(err.code, 'missing_chunks')
    assert.deepEqual(err.extra.missing, [0])
    return true
  })
  const st = await store.status(s.uploadId, 'u1')
  assert.deepEqual(st.received, [1])
})

test('owner mismatch → 403, unknown/malformed id → 404', async () => {
  const s = await store.init({ filename: 'a.bin', size: 10 }, 'u1')
  await rejects(store.status(s.uploadId, 'u2'), 403, 'forbidden')
  await rejects(store.putChunk(s.uploadId, 0, rand(10), 'u2'), 403, 'forbidden')
  await rejects(store.complete(s.uploadId, 'u2'), 403, 'forbidden')
  await rejects(store.abort(s.uploadId, 'u2'), 403, 'forbidden')
  await rejects(store.status('nope-nope-nope', 'u1'), 404, 'not_found')
  await rejects(store.status('../etc', 'u1'), 404, 'not_found')
  // anonymous owner only matches anonymous
  const anon = await store.init({ filename: 'a.bin', size: 10 }, null)
  await rejects(store.status(anon.uploadId, 'u1'), 403, 'forbidden')
  await store.status(anon.uploadId, undefined)
})

test('sha256 mismatch → 422 and the session is destroyed', async () => {
  const data = rand(3 * KB)
  const s = await store.init({ filename: 'a.bin', size: data.length, sha256: sha(rand(3)) }, 'u1')
  await store.putChunk(s.uploadId, 0, data, 'u1')
  await rejects(store.complete(s.uploadId, 'u1'), 422, 'hash_mismatch')
  await rejects(store.status(s.uploadId, 'u1'), 404, 'not_found')
})

test('sha256 match passes (case-insensitive)', async () => {
  const data = rand(3 * KB)
  const s = await store.init({ filename: 'a.bin', size: data.length, sha256: sha(data).toUpperCase() }, 'u1')
  await store.putChunk(s.uploadId, 0, data, 'u1')
  const done = await store.complete(s.uploadId, 'u1')
  assert.equal(done.sha256, sha(data))
  await done.release()
})

test('sessions survive a store restart (resume)', async () => {
  const data = rand(8 * KB)
  const s = await store.init({ filename: 'a.bin', size: data.length }, 'u1')
  await store.putChunk(s.uploadId, 0, data.subarray(0, 4 * KB), 'u1')
  const store2 = createChunkStore({ dir, defaultChunkSize: 4 * KB, maxChunkSize: 8 * KB, maxFileSize: 100 * KB })
  const st = await store2.status(s.uploadId, 'u1')
  assert.deepEqual(st.received, [0])
  assert.equal(st.totalChunks, 2)
  await store2.putChunk(s.uploadId, 1, data.subarray(4 * KB), 'u1')
  const done = await store2.complete(s.uploadId, 'u1')
  assert.ok(Buffer.from(fs.readFileSync(done.path)).equals(data))
  await done.release()
})

test('abort removes the session', async () => {
  const s = await store.init({ filename: 'a.bin', size: 10 }, 'u1')
  await store.abort(s.uploadId, 'u1')
  await rejects(store.status(s.uploadId, 'u1'), 404, 'not_found')
  await rejects(store.abort(s.uploadId, 'u1'), 404, 'not_found')
})

test('sweep removes expired sessions only and ignores junk', async () => {
  const old = await store.init({ filename: 'a.bin', size: 10 }, 'u1')
  const fresh = await store.init({ filename: 'b.bin', size: 10 }, 'u1')
  const metaPath = path.join(dir, old.uploadId, 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, createdAt: Date.now() - 120_000 }))
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'x')
  fs.mkdirSync(path.join(dir, 'no-meta-dir'))
  const n = await store.sweep()
  assert.equal(n, 1)
  await rejects(store.status(old.uploadId, 'u1'), 404, 'not_found')
  await store.status(fresh.uploadId, 'u1')
})

test('sanitizeFilename blocks traversal, dotfiles, Windows illegal chars and device names', async () => {
  const { sanitizeFilename } = await import('../index.js')
  assert.equal(sanitizeFilename('..'), '')
  assert.equal(sanitizeFilename('.'), '')
  assert.equal(sanitizeFilename('..\\..\\x.txt'), 'x.txt')
  assert.equal(sanitizeFilename('.env'), 'env')
  assert.equal(sanitizeFilename('report.txt:$DATA'), 'report.txt_$DATA')
  assert.equal(sanitizeFilename('CON'), '_CON')
  assert.equal(sanitizeFilename('nul.txt'), '_nul.txt')
  assert.equal(sanitizeFilename('trailing. . '), 'trailing')
  assert.equal(sanitizeFilename('a<b>c|d?e*f"g'), 'a_b_c_d_e_f_g')
  assert.equal(sanitizeFilename('正常 檔名.mp4'), '正常 檔名.mp4')
})

test('concurrent complete() is single-flight: both callers get the same result, file intact', async () => {
  const data = rand(12 * KB)
  const s = await store.init({ filename: 'race.bin', size: data.length }, 'u1')
  for (let i = 0; i < 3; i++) await store.putChunk(s.uploadId, i, data.subarray(i * 4 * KB, (i + 1) * 4 * KB), 'u1')
  const [a, b] = await Promise.all([store.complete(s.uploadId, 'u1'), store.complete(s.uploadId, 'u1')])
  assert.equal(a.path, b.path)
  assert.equal(a.sha256, sha(data))
  assert.equal(b.sha256, sha(data))
  assert.ok(Buffer.from(fs.readFileSync(a.path)).equals(data))
  // a late joiner with the wrong owner is still refused
  const s2 = await store.init({ filename: 'race2.bin', size: 3 * KB }, 'u1')
  await store.putChunk(s2.uploadId, 0, rand(3 * KB), 'u1')
  const p = store.complete(s2.uploadId, 'u1')
  await rejects(store.complete(s2.uploadId, 'u2'), 403, 'forbidden')
  const ok = await p
  await a.release()
  await ok.release()
})

test('putChunk / abort during complete → 409 completing', async () => {
  const data = rand(4 * KB)
  const s = await store.init({ filename: 'c.bin', size: data.length }, 'u1')
  await store.putChunk(s.uploadId, 0, data, 'u1')
  const p = store.complete(s.uploadId, 'u1')
  await rejects(store.putChunk(s.uploadId, 0, data, 'u1'), 409, 'completing')
  await rejects(store.abort(s.uploadId, 'u1'), 409, 'completing')
  const done = await p
  await done.release()
})

test('per-owner in-flight session cap → 429, and the cap survives a restart', async () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-cap-'))
  const capped = createChunkStore({ dir: capDir, maxSessionsPerOwner: 2 })
  const a = await capped.init({ filename: 'a', size: 1 }, 'owner-x')
  await capped.init({ filename: 'b', size: 1 }, 'owner-x')
  await rejects(capped.init({ filename: 'c', size: 1 }, 'owner-x'), 429, 'too_many_sessions')
  await capped.init({ filename: 'c', size: 1 }, 'owner-y') // other owner unaffected
  const restarted = createChunkStore({ dir: capDir, maxSessionsPerOwner: 2 })
  await rejects(restarted.init({ filename: 'd', size: 1 }, 'owner-x'), 429, 'too_many_sessions')
  await restarted.abort(a.uploadId, 'owner-x')
  await restarted.init({ filename: 'd', size: 1 }, 'owner-x')
  fs.rmSync(capDir, { recursive: true, force: true })
})

test('too many chunks → 400', async () => {
  const tiny = createChunkStore({ dir, defaultChunkSize: KB, maxChunkSize: KB, maxFileSize: 100 * KB, maxChunks: 4 })
  await rejects(tiny.init({ filename: 'a.bin', size: 10 * KB }, 'u1'), 400, 'too_many_chunks')
})
