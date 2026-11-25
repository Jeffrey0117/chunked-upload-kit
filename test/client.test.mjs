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

// ── lost acknowledgements ────────────────────────────────────────────────────
// Seen on an iPhone (2026-11-25, pokkit over plain-http LAN): the server stored
// every chunk and answered 200, the browser never delivered the response. The
// client waited out the 120s timeout and re-sent the same chunks, forever.

// XHR stand-in: really PUTs the body, reports the upload as sent, and (while
// `swallow` > 0) never delivers the response.
function fakeXhrClass(state) {
  return class FakeXhr {
    constructor() {
      this.readyState = 0; this.status = 0; this.responseText = ''; this.timeout = 0
      this._h = {}; this._l = {}; this._ul = {}; this._done = false
      this.upload = { addEventListener: (t, fn) => { (this._ul[t] ||= []).push(fn) } }
    }
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn) }
    _fire(map, t, e = {}) { for (const fn of map[t] || []) fn(e) }
    open(method, url) { this._method = method; this._url = url; this.readyState = 1 }
    setRequestHeader(k, v) { this._h[k] = v }
    send(blob) {
      state.puts.push(this._url)
      const swallow = state.swallow > 0
      if (swallow) state.swallow--
      if (this.timeout > 0) this._t = setTimeout(() => { if (!this._done) { this._done = true; this._fire(this._l, 'timeout') } }, this.timeout)
      fetch(this._url, { method: this._method, headers: this._h, body: blob }).then(async (res) => {
        const text = await res.text()
        if (this._done) return
        this._fire(this._ul, 'progress', { lengthComputable: true, loaded: blob.size, total: blob.size })
        this._fire(this._ul, 'load')
        if (swallow) return // the response never reaches the page
        this._done = true; clearTimeout(this._t)
        this.status = res.status; this.responseText = text; this.readyState = 4
        this._fire(this._l, 'load')
      })
    }
    abort() { if (this._done) return; this._done = true; clearTimeout(this._t); this._fire(this._l, 'abort') }
  }
}

test('a chunk the server stored but never acknowledged is not sent again', async () => {
  received = []
  const data = crypto.randomBytes(12 * KB) // 3 chunks
  const state = { puts: [], swallow: 3 }
  const events = []
  const realXhr = globalThis.XMLHttpRequest
  globalThis.XMLHttpRequest = fakeXhrClass(state)
  const started = Date.now()
  try {
    const result = await uploadChunked(new Blob([data]), {
      endpoint, headers, filename: 'lost-ack.mov', useXhr: true,
      ackProbeMs: 30, chunkTimeoutMs: 4000, retryDelayMs: 5,
      onEvent: (e) => events.push(e),
    })
    assert.equal(result.filename, 'lost-ack.mov')
  } finally {
    globalThis.XMLHttpRequest = realXhr
  }
  assert.ok(received[0].bytes.equals(data))
  assert.equal(state.puts.length, 3, `each chunk goes up once, got ${state.puts.length} PUTs`)
  assert.ok(Date.now() - started < 3000, 'must not wait for the chunk timeout')
  assert.equal(events.filter((e) => e.type === 'ack-lost').length, 3)
})

test('a chunk that fails after the server stored it is confirmed instead of re-sent', async () => {
  received = []
  const data = crypto.randomBytes(12 * KB)
  const puts = []
  let drop = 2
  const lossyFetch = async (url, init) => {
    if (init?.method !== 'PUT') return fetch(url, init)
    puts.push(url)
    const res = await fetch(url, init)
    if (drop > 0) { drop--; await res.text(); throw new TypeError('connection reset') }
    return res
  }
  const events = []
  const result = await uploadChunked(new Blob([data]), {
    endpoint, headers, filename: 'reset.bin', fetch: lossyFetch, useXhr: false, retryDelayMs: 5, concurrency: 1,
    onEvent: (e) => events.push(e),
  })
  assert.equal(result.filename, 'reset.bin')
  assert.ok(received[0].bytes.equals(data))
  assert.equal(puts.length, 3, `got ${puts.length} PUTs`)
  assert.equal(events.filter((e) => e.type === 'chunk-recovered').length, 2)
})
