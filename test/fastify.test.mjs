import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createChunkStore, registerChunkedUpload, ChunkError } from '../index.js'

const KB = 1024
let app
let dir
let completed = []

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-fastify-'))
  app = Fastify({ logger: false })
  const store = createChunkStore({ dir, defaultChunkSize: 4 * KB, maxChunkSize: 8 * KB, maxFileSize: 64 * KB })
  registerChunkedUpload(app, {
    prefix: '/api/upload/chunked',
    store,
    auth: (req, reply) => {
      const t = req.headers.authorization
      if (t === 'Bearer alice') return 'alice'
      if (t === 'Bearer bob') return 'bob'
      if (t === 'Bearer custom') { reply.code(418).send({ error: 'teapot' }); return null }
      return null
    },
    onComplete: async (file) => {
      const bytes = fs.readFileSync(file.path)
      completed.push({ ...file, bytes })
      return { id: 'saved-' + file.sha256.slice(0, 8), size: file.size, meta: file.meta }
    },
  })
  // a host route outside the plugin must not be affected by the octet-stream parser
  app.post('/plain', async () => ({ ok: true }))
  await app.ready()
})
after(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const H = (who) => ({ authorization: `Bearer ${who}` })
const init = (who, body) => app.inject({ method: 'POST', url: '/api/upload/chunked/init', headers: { ...H(who), 'content-type': 'application/json' }, payload: JSON.stringify(body) })
const put = (who, id, i, buf, headers = {}) => app.inject({ method: 'PUT', url: `/api/upload/chunked/${id}/${i}`, headers: { ...H(who), 'content-type': 'application/octet-stream', ...headers }, payload: buf })
const complete = (who, id) => app.inject({ method: 'POST', url: `/api/upload/chunked/${id}/complete`, headers: H(who) })
const status = (who, id) => app.inject({ method: 'GET', url: `/api/upload/chunked/${id}`, headers: H(who) })

test('401 without auth; custom auth reply is respected', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/upload/chunked/init', payload: { filename: 'a', size: 1 } })
  assert.equal(r.statusCode, 401)
  const c = await init('custom', { filename: 'a', size: 1 })
  assert.equal(c.statusCode, 418)
})

test('end-to-end: init → put → complete → onComplete result is the response', async () => {
  completed = []
  const data = crypto.randomBytes(9 * KB)
  const r = await init('alice', { filename: 'clip.mp4', size: data.length, mime: 'video/mp4', meta: { album_id: 'A1' } })
  assert.equal(r.statusCode, 200, r.body)
  const s = r.json()
  assert.equal(s.totalChunks, 3)

  // out of order, with one duplicate
  for (const i of [2, 0, 1, 1]) {
    const part = data.subarray(i * s.chunkSize, (i + 1) * s.chunkSize)
    const p = await put('alice', s.uploadId, i, part)
    assert.equal(p.statusCode, 200, p.body)
  }
  const st = await status('alice', s.uploadId)
  assert.deepEqual(st.json().received, [0, 1, 2])

  const c = await complete('alice', s.uploadId)
  assert.equal(c.statusCode, 200, c.body)
  const body = c.json()
  assert.match(body.id, /^saved-/)
  assert.equal(body.size, data.length)
  assert.deepEqual(body.meta, { album_id: 'A1' })
  assert.equal(completed.length, 1)
  assert.ok(completed[0].bytes.equals(data))
  assert.equal(completed[0].owner, 'alice')
  // session released after onComplete
  assert.ok(!fs.existsSync(path.join(dir, s.uploadId)))
  assert.equal((await status('alice', s.uploadId)).statusCode, 404)
})

test('error mapping: 403 other owner, 400 bad length, 409 missing, 413 too large, 404 unknown', async () => {
  const data = crypto.randomBytes(8 * KB)
  const s = (await init('alice', { filename: 'a.bin', size: data.length })).json()
  assert.equal((await status('bob', s.uploadId)).statusCode, 403)

  const bad = await put('alice', s.uploadId, 0, data.subarray(0, 100))
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().code, 'bad_chunk_length')

  // content-length lie is caught up front
  const lie = await put('alice', s.uploadId, 0, data.subarray(0, 4 * KB), { 'content-length': '5' })
  assert.equal(lie.statusCode, 400)

  await put('alice', s.uploadId, 0, data.subarray(0, 4 * KB))
  const c = await complete('alice', s.uploadId)
  assert.equal(c.statusCode, 409)
  assert.deepEqual(c.json().missing, [1])

  const big = await init('alice', { filename: 'a.bin', size: 10 * 1024 * KB })
  assert.equal(big.statusCode, 413)
  assert.equal((await status('alice', 'does-not-exist')).statusCode, 404)
})

test('onComplete throwing → 500 and the session is still released', async () => {
  const data = crypto.randomBytes(KB)
  const s = (await init('alice', { filename: 'boom.bin', size: data.length })).json()
  await put('alice', s.uploadId, 0, data)
  // make onComplete fail by tampering: remove read permission is unreliable on Windows, so
  // instead simulate by asking for a meta the handler will choke on… simplest: delete the
  // assembled file behind the store's back is also racy. Use a dedicated app instead.
  const app2 = Fastify({ logger: false })
  const store2 = createChunkStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-f2-')), defaultChunkSize: KB, maxChunkSize: KB })
  registerChunkedUpload(app2, { prefix: '/u', store: store2, auth: () => 'x', onComplete: async () => { throw new Error('db down') } })
  await app2.ready()
  const s2 = (await app2.inject({ method: 'POST', url: '/u/init', headers: { authorization: 'x', 'content-type': 'application/json' }, payload: JSON.stringify({ filename: 'a', size: 3 }) })).json()
  await app2.inject({ method: 'PUT', url: `/u/${s2.uploadId}/0`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('abc') })
  const r = await app2.inject({ method: 'POST', url: `/u/${s2.uploadId}/complete` })
  assert.equal(r.statusCode, 500)
  assert.equal(r.json().code, 'internal')
  assert.ok(!fs.existsSync(path.join(store2.dir, s2.uploadId)))
  await app2.close()
  fs.rmSync(store2.dir, { recursive: true, force: true })
})

test('onInit can refuse before any byte lands; completeBody reaches onComplete', async () => {
  const app3 = Fastify({ logger: false })
  const store3 = createChunkStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-f3-')), defaultChunkSize: KB, maxChunkSize: KB })
  const seen = []
  registerChunkedUpload(app3, {
    prefix: '/u',
    store: store3,
    auth: () => 'x',
    onInit: (body, owner) => { if (body.meta?.album === 'locked') throw new ChunkError(403, 'no_album', 'nope') },
    onComplete: async (file, req) => { seen.push(req.completeBody); return { ok: 1 } },
  })
  await app3.ready()
  const refused = await app3.inject({ method: 'POST', url: '/u/init', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ filename: 'a', size: 3, meta: { album: 'locked' } }) })
  assert.equal(refused.statusCode, 403)
  assert.equal(refused.json().code, 'no_album')
  assert.equal(fs.readdirSync(store3.dir).length, 0, 'no session dir created')

  const s = (await app3.inject({ method: 'POST', url: '/u/init', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ filename: 'a', size: 3 }) })).json()
  await app3.inject({ method: 'PUT', url: `/u/${s.uploadId}/0`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('abc') })
  const c = await app3.inject({ method: 'POST', url: `/u/${s.uploadId}/complete`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ password: 'hunter2' }) })
  assert.equal(c.statusCode, 200, c.body)
  assert.deepEqual(seen, [{ password: 'hunter2' }])
  await app3.close()
  fs.rmSync(store3.dir, { recursive: true, force: true })
})

test('real socket: body-less POST /complete re-framed as chunked (proxy style) still works; early PUT error is delivered', async () => {
  const app4 = Fastify({ logger: false })
  const store4 = createChunkStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-f4-')), defaultChunkSize: 64 * KB, maxChunkSize: 64 * KB })
  registerChunkedUpload(app4, { prefix: '/u', store: store4, auth: (req) => (req.headers.authorization ? 'x' : null), onComplete: async (f) => ({ size: f.size }) })
  await app4.listen({ port: 0, host: '127.0.0.1' })
  const port = app4.server.address().port
  const { default: http } = await import('node:http')
  const raw = (method, p, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let t = ''
      res.on('data', (d) => { t += d })
      res.on('end', () => resolve({ status: res.statusCode, body: t }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
  const s = JSON.parse((await raw('POST', '/u/init', { authorization: 'k', 'content-type': 'application/json' }, JSON.stringify({ filename: 'a', size: 3 }))).body)
  await raw('PUT', `/u/${s.uploadId}/0`, { authorization: 'k', 'content-type': 'application/octet-stream', 'content-length': '3' }, 'abc')
  // what Cloudflare/tunnel/proxy chains do to a body-less POST: no content-type, chunked framing
  const c = await raw('POST', `/u/${s.uploadId}/complete`, { authorization: 'k', 'transfer-encoding': 'chunked' }, '')
  assert.equal(c.status, 200, c.body)
  assert.deepEqual(JSON.parse(c.body), { size: 3 })

  // 401 while a 64KB body is still being written: the JSON must arrive, not a reset
  const s2 = JSON.parse((await raw('POST', '/u/init', { authorization: 'k', 'content-type': 'application/json' }, JSON.stringify({ filename: 'b', size: 64 * KB }))).body)
  const early = await raw('PUT', `/u/${s2.uploadId}/0`, { 'content-type': 'application/octet-stream', 'content-length': String(64 * KB) }, crypto.randomBytes(64 * KB))
  assert.equal(early.status, 401)
  assert.equal(JSON.parse(early.body).code, 'unauthorized')
  await app4.close()
  fs.rmSync(store4.dir, { recursive: true, force: true })
})

test('octet-stream parser does not leak outside the plugin', async () => {
  const r = await app.inject({ method: 'POST', url: '/plain', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') })
  assert.equal(r.statusCode, 415)
})
