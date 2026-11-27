// lan-probe: "在家就走家裡網路" — pick the LAN host when it answers, never break when it doesn't.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { probeLan, lanBaseFor } = require('../client/lan-probe.js')

function memStorage() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }
}

test('lanBaseFor: app.example.com → https://app.lan.example.com', () => {
  assert.equal(lanBaseFor('plottr.example.com'), 'https://plottr.lan.example.com')
  assert.equal(lanBaseFor('Plottr.Example.com', { sub: 'home' }), 'https://plottr.home.example.com')
  assert.equal(lanBaseFor('example.com'), null, 'two labels: no app name to keep')
  assert.equal(lanBaseFor('localhost'), null)
  assert.equal(lanBaseFor('192.168.0.11'), null)
  assert.equal(lanBaseFor('plottr.lan.example.com'), null, 'already on the LAN host')
})

test('answers → LAN base; cached so the next upload does not ask again', async () => {
  let calls = 0
  const fetch = async (url) => { calls++; assert.equal(url, 'https://a.lan.example.com/__lan/ping'); return { ok: true } }
  const storage = memStorage()
  assert.equal(await probeLan('https://a.lan.example.com', { fetch, storage }), 'https://a.lan.example.com')
  assert.equal(await probeLan('https://a.lan.example.com', { fetch, storage }), 'https://a.lan.example.com')
  assert.equal(calls, 1)
})

test('not at home (network error / timeout / non-2xx) → null, never throws', async () => {
  assert.equal(await probeLan('https://a.lan.example.com', { fetch: async () => { throw new TypeError('Failed to fetch') }, storage: null }), null)
  assert.equal(await probeLan('https://a.lan.example.com', { fetch: async () => ({ ok: false }), storage: null }), null)
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))
  const t0 = Date.now()
  assert.equal(await probeLan('https://a.lan.example.com', { fetch: hang, timeoutMs: 80, storage: null }), null)
  assert.ok(Date.now() - t0 < 1000)
})

test('a "no" is cached too, and the cache expires', async () => {
  let calls = 0
  let clock = 1000
  const fetch = async () => { calls++; return { ok: false } }
  const storage = memStorage()
  const opts = { fetch, storage, now: () => clock, cacheMs: 5000 }
  await probeLan('https://a.lan.example.com', opts)
  await probeLan('https://a.lan.example.com', opts)
  assert.equal(calls, 1)
  clock += 6000
  await probeLan('https://a.lan.example.com', opts)
  assert.equal(calls, 2)
})

test('no LAN base → null without any request', async () => {
  assert.equal(await probeLan(null, { fetch: async () => { throw new Error('should not be called') } }), null)
})

test('uploadChunked({ lan }) sends to the LAN host when it answers, stays put when not', async () => {
  const { uploadChunked } = await import('../client/index.mjs')
  for (const [pingOk, expectPrefix] of [[true, 'https://a.lan.example.com/api/up'], [false, '/api/up']]) {
    const urls = []
    const fetch = async (url) => {
      urls.push(url)
      if (url.endsWith('/__lan/ping')) return { ok: pingOk }
      return { ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({ error: 'stop here' }), text: async () => '{"error":"stop here"}' }
    }
    globalThis.sessionStorage = undefined
    await assert.rejects(uploadChunked(new Blob(['x']), { endpoint: '/api/up', lan: 'https://a.lan.example.com', fetch, useXhr: false }))
    assert.ok(urls[1].startsWith(expectPrefix), `${urls[1]} should start with ${expectPrefix}`)
  }
})
