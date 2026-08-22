// Client (Node flavour: fetch + Blob) against a real fastify server on a real port.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createChunkStore, registerChunkedUpload } from '../index.js'
import { uploadChunked, abortUpload, UploadError } from '../client/index.mjs'

const KB = 1024
let app
let dir
let endpoint
let flakyPuts = 0
let received = []

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-client-'))
  app = Fastify({ logger: false })
  const store = createChunkStore({ dir, defaultChunkSize: 4 * KB, maxChunkSize: 8 * KB, maxFileSize: 256 * KB })
  // inject one transient 503 per upload to prove the client retries
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'PUT' && flakyPuts > 0) { flakyPuts--; reply.code(503).send({ error: 'flaky' }) }
  })
  registerChunkedUpload(app, {
    prefix: '/c',
    store,
    auth: (req) => (req.headers.authorization === 'Bearer ok' ? 'me' : null),
    onComplete: async (file) => {
      received.push({ ...file, bytes: fs.readFileSync(file.path) })
      return { id: file.sha256.slice(0, 8), filename: file.filename, meta: file.meta }
    },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  endpoint = `http://127.0.0.1:${app.server.address().port}/c`
})
after(async () => {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const headers = { authorization: 'Bearer ok' }

test('uploads a Blob in chunks with progress, retrying a transient 503', async () => {
  received = []
  flakyPuts = 1
  const data = crypto.randomBytes(11 * KB)
  const events = []
  const result = await uploadChunked(new Blob([data]), {
    endpoint,
    headers,
    filename: 'movie.mp4',
    mime: 'video/mp4',
    meta: { album_id: 'Z' },
    concurrency: 2,
    retryDelayMs: 5,
    onProgress: (p) => events.push(p),
  })
  assert.equal(result.filename, 'movie.mp4')
  assert.deepEqual(result.meta, { album_id: 'Z' })
  assert.ok(received[0].bytes.equals(data))
  assert.equal(received[0].mime, 'video/mp4')
  const last = events[events.length - 1]
  assert.equal(last.loaded, data.length)
  assert.equal(last.percent, 100)
  assert.ok(events.every((e) => e.total === data.length))
  assert.equal(flakyPuts, 0)
})

test('non-retryable 4xx surfaces as UploadError with code and uploadId', async () => {
  const data = crypto.randomBytes(KB)
  await assert.rejects(
    uploadChunked(new Blob([data]), { endpoint, headers: { authorization: 'Bearer nope' }, filename: 'a' }),
    (err) => err instanceof UploadError && err.status === 401 && err.code === 'unauthorized',
  )
  await assert.rejects(
    uploadChunked(new Blob([crypto.randomBytes(1024 * KB)]), { endpoint, headers, filename: 'huge' }),
    (err) => err instanceof UploadError && err.status === 413 && err.code === 'too_large',
  )
})

test('resume: a second call with uploadId only sends the missing chunks', async () => {
  received = []
  const data = crypto.randomBytes(12 * KB)
  // first attempt: abort midway via AbortController after the first chunk lands
  const ac = new AbortController()
  let firstId = null
  await assert.rejects(
    uploadChunked(new Blob([data]), {
      endpoint,
      headers,
      filename: 'r.bin',
      concurrency: 1,
      onProgress: (p) => { firstId = p.uploadId; if (p.loaded >= 4 * KB) ac.abort() },
      signal: ac.signal,
    }),
    (err) => err.code === 'aborted',
  )
  assert.ok(firstId)
  const st = await (await fetch(`${endpoint}/${firstId}`, { headers })).json()
  assert.ok(st.received.length >= 1 && st.received.length < 3, `received=${st.received}`)

  const puts = []
  const countingFetch = (url, init) => { if (init?.method === 'PUT') puts.push(url); return fetch(url, init) }
  const result = await uploadChunked(new Blob([data]), { endpoint, headers, filename: 'r.bin', uploadId: firstId, fetch: countingFetch, useXhr: false })
  assert.equal(result.filename, 'r.bin')
  assert.equal(puts.length, 3 - st.received.length)
  assert.ok(received[0].bytes.equals(data))
})

test('abort signal fired between chunks settles (no hang) and marks the error resumable', async () => {
  const data = crypto.randomBytes(12 * KB)
  const ac = new AbortController()
  let calls = 0
  const gateFetch = (url, init) => {
    if (init?.method === 'PUT') { calls++; if (calls === 1) ac.abort() }
    return fetch(url, init)
  }
  const t = setTimeout(() => { throw new Error('hung') }, 10_000)
  await assert.rejects(
    uploadChunked(new Blob([data]), { endpoint, headers, filename: 'h.bin', concurrency: 1, signal: ac.signal, fetch: gateFetch, useXhr: false }),
    (err) => err.code === 'aborted' && err.resumable === true && !!err.uploadId,
  )
  clearTimeout(t)
})

test('resume refuses a different file with the same size (filename mismatch)', async () => {
  const data = crypto.randomBytes(4 * KB)
  const s = await (await fetch(`${endpoint}/init`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'one.bin', size: data.length }) })).json()
  await assert.rejects(
    uploadChunked(new Blob([data]), { endpoint, headers, filename: 'two.bin', uploadId: s.uploadId }),
    (err) => err.code === 'resume_mismatch',
  )
  await abortUpload(s.uploadId, { endpoint, headers })
})

test('/complete is retried on a transient 5xx and non-resumable 4xx errors say so', async () => {
  received = []
  const data = crypto.randomBytes(5 * KB)
  let completes = 0
  const flakyComplete = (url, init) => {
    if (init?.method === 'POST' && url.endsWith('/complete') && completes++ === 0) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 }))
    }
    return fetch(url, init)
  }
  const r = await uploadChunked(new Blob([data]), { endpoint, headers, filename: 'c.bin', fetch: flakyComplete, useXhr: false, retryDelayMs: 5 })
  assert.equal(r.filename, 'c.bin')
  assert.equal(completes, 2)

  await assert.rejects(
    uploadChunked(new Blob([crypto.randomBytes(1024 * KB)]), { endpoint, headers, filename: 'huge' }),
    (err) => err.status === 413 && err.resumable === false,
  )
})

test('abortUpload cleans up server state and never throws', async () => {
  const s = await (await fetch(`${endpoint}/init`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'x', size: 10 }) })).json()
  assert.equal(await abortUpload(s.uploadId, { endpoint, headers }), true)
  assert.equal((await fetch(`${endpoint}/${s.uploadId}`, { headers })).status, 404)
  assert.equal(await abortUpload('missing', { endpoint, headers }), false)
  assert.equal(await abortUpload('x', { endpoint: 'http://127.0.0.1:1/c' }), false)
})
