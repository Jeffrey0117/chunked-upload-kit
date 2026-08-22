# chunked-upload-kit

**Chunked / resumable uploads that survive request-body caps** — Cloudflare's 100 MB limit, nginx `client_max_body_size`, serverless payload limits. Zero runtime dependencies, framework-agnostic core, thin fastify/express adapters, one browser+Node client.

The problem it solves: a single `multipart/form-data` POST of a 400 MB video never reaches your origin when a proxy in front caps bodies at 100 MB (Cloudflare answers `413` at the edge and the browser's progress bar just freezes at 4 %). Split the file into chunks well under the cap, send them in parallel, reassemble on the server — every request is small, the file is not.

## Install

```bash
npm i github:Jeffrey0117/chunked-upload-kit
```

Node ≥ 18. The client is ESM (`client/index.mjs`) and runs in browsers and Node; the server side is CJS and imports cleanly from ESM/TypeScript.

## Server (fastify)

```js
import { createChunkStore, registerChunkedUpload } from 'chunked-upload-kit'

const store = createChunkStore({
  dir: './data/chunks',          // in-flight sessions live here
  maxFileSize: 500 * 1024 * 1024,
  maxChunkSize: 32 * 1024 * 1024, // MUST stay under your proxy's body cap
})
store.startSweeper()              // drop abandoned sessions (24h TTL) hourly

registerChunkedUpload(app, {
  prefix: '/api/upload/chunked',
  store,
  auth: (req, reply) => getUserId(req) ?? null,           // null → 401
  onInit: async (body, owner) => {                          // optional: refuse early
    if (await overQuota(owner)) throw new ChunkError(413, 'quota', 'Storage full')
  },
  onComplete: async (file, req) => {
    // file = { path, filename, mime, size, sha256, meta, owner, release() }
    // req.completeBody = JSON the client sent with /complete (e.g. a password)
    const entry = await saveToYourStorage(file.path, file)
    return { id: entry.id, url: entry.url }                  // ← RETURN it; don't reply.send()
  },
})
```

`file.path` is the fully assembled file on local disk; it is deleted automatically after `onComplete` returns (or throws — you get a 500 and no leftovers).

## Server (express / plain `http`)

```js
const { createChunkStore, chunkedUploadHandler } = require('chunked-upload-kit')

app.use('/api/upload/chunked', chunkedUploadHandler({
  store,
  auth: (req) => req.user?.id ?? null,
  onComplete: async (file) => ({ id: await persist(file) }),
}))
```

No `express.json()` needed — the handler parses its own `/init` body and streams chunk bodies directly.

## Client

```js
import { uploadChunked, UploadError } from 'chunked-upload-kit/client'

try {
  const result = await uploadChunked(file, {
    endpoint: '/api/upload/chunked',
    headers: { Authorization: 'Bearer ' + token },   // or getHeaders: async () => ({...})
    meta: { album_id },                               // stored with the session → file.meta
    completeBody: { password },                       // sent only with /complete → req.completeBody
    onProgress: ({ loaded, total, percent }) => bar.style.width = percent + '%',
  })
  // result = whatever your onComplete returned
} catch (err) {
  if (err instanceof UploadError && err.resumable) {
    // keep err.uploadId → uploadChunked(file, { ...opts, uploadId }) resumes, sending only missing chunks
  }
}
```

Browsers get real upload progress (XHR, with a per-chunk timeout); Node uses `fetch`. Transient failures (network, 408/429/5xx) retry per chunk — and on `/complete` — with exponential backoff; 4xx surface immediately as `UploadError { status, code, body, uploadId, resumable }`.

## Protocol

| Step | Route | Body | Response |
|---|---|---|---|
| init | `POST {prefix}/init` | `{filename,size,mime?,chunkSize?,sha256?,meta?}` | `{uploadId,chunkSize,totalChunks,received}` |
| chunk | `PUT {prefix}/{uploadId}/{index}` | raw bytes, `application/octet-stream` | `{received,done}` |
| status | `GET {prefix}/{uploadId}` | – | `{…,received}` (for resume) |
| complete | `POST {prefix}/{uploadId}/complete` | JSON (optional; e.g. secrets — exposed as `req.completeBody`) | your `onComplete` result |
| abort | `DELETE {prefix}/{uploadId}` | – | `{ok:true}` |

Errors are JSON `{error, code, …}`: `400 bad_chunk_length/bad_index/bad_size/…`, `401 unauthorized`, `403 forbidden` (another owner's session), `404 not_found`, `409 missing_chunks {missing}` / `409 completing`, `413 too_large`, `422 hash_mismatch`, `429 too_many_sessions`.

Guarantees: every chunk must be exactly `chunkSize` bytes (last = remainder), re-PUT is idempotent, `/complete` is single-flight and safe to retry (a second call joins the in-flight one), sessions are bound to the owner returned by `auth` and capped per owner (`maxSessionsPerOwner`, default 16), sessions persist on disk so a server restart does not lose an in-flight upload, and the assembled file's sha256 is always computed (verified against `sha256` if the client sent one) — handy for dedup. Use `onInit` to refuse (quota, permissions) before any byte lands.

## API

`createChunkStore({ dir, defaultChunkSize=16MiB, maxChunkSize=32MiB, minChunkSize=1KiB, maxFileSize=2GiB, maxChunks=4096, ttlMs=24h, log })`
→ `{ init, status, putChunk, complete, abort, sweep, startSweeper, dir, limits }` — see `index.d.ts`.

The core is usable without either adapter (e.g. from a Koa/Hono/raw-http handler): `putChunk(uploadId, index, bufferOrReadable, owner, { length })`.

## Test

```bash
npm test     # node:test — store, fastify adapter, express adapter, client (real ports)
```

## License

MIT © Jeffrey0117
