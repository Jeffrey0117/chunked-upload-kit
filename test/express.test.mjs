import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import express from 'express'
import { createChunkStore, chunkedUploadHandler } from '../index.js'

const KB = 1024
let server
let base
let dir
let seen = []

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuk-express-'))
  const app = express()
  const store = createChunkStore({ dir, defaultChunkSize: 4 * KB, maxChunkSize: 8 * KB, maxFileSize: 64 * KB })
  app.use('/up', chunkedUploadHandler({
    store,
    auth: (req) => (req.headers['x-user'] ? String(req.headers['x-user']) : null),
    onComplete: async (file) => {
      seen.push({ ...file, bytes: fs.readFileSync(file.path) })
      return { stored: file.filename, sha256: file.sha256 }
    },
    log: () => {},
  }))
  app.get('/other', (_req, res) => res.json({ ok: true }))
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}/up`
})
after(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

const H = { 'x-user': 'u1' }

test('401 without auth, 404 passthrough for unknown paths inside the mount', async () => {
  const r = await fetch(`${base}/init`, { method: 'POST', body: '{}' })
  assert.equal(r.status, 401)
  const nf = await fetch(`${base}/nope/what/ever`, { headers: H })
  assert.equal(nf.status, 404)
})

test('end-to-end over real HTTP (no express.json needed)', async () => {
  const data = crypto.randomBytes(6 * KB + 7)
  const s = await (await fetch(`${base}/init`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'x.bin', size: data.length }) })).json()
  assert.equal(s.totalChunks, 2)
  for (let i = 0; i < 2; i++) {
    const part = data.subarray(i * s.chunkSize, (i + 1) * s.chunkSize)
    const r = await fetch(`${base}/${s.uploadId}/${i}`, { method: 'PUT', headers: { ...H, 'content-type': 'application/octet-stream' }, body: part })
    assert.equal(r.status, 200, await r.text())
  }
  const st = await (await fetch(`${base}/${s.uploadId}`, { headers: H })).json()
  assert.deepEqual(st.received, [0, 1])
  const c = await fetch(`${base}/${s.uploadId}/complete`, { method: 'POST', headers: H })
  assert.equal(c.status, 200)
  const body = await c.json()
  assert.equal(body.stored, 'x.bin')
  assert.ok(seen[0].bytes.equals(data))
  assert.equal(body.sha256, crypto.createHash('sha256').update(data).digest('hex'))
})

test('errors come back as JSON with status + code', async () => {
  const s = await (await fetch(`${base}/init`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'x.bin', size: 8 * KB }) })).json()
  const bad = await fetch(`${base}/${s.uploadId}/0`, { method: 'PUT', headers: { ...H, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(10) })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'bad_chunk_length')
  const other = await fetch(`${base}/${s.uploadId}`, { headers: { 'x-user': 'u2' } })
  assert.equal(other.status, 403)
  const badJson = await fetch(`${base}/init`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{not json' })
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).code, 'bad_json')
  const del = await fetch(`${base}/${s.uploadId}`, { method: 'DELETE', headers: H })
  assert.equal(del.status, 200)
  assert.equal((await fetch(`${base}/${s.uploadId}`, { headers: H })).status, 404)
})
