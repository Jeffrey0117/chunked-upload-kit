'use strict';
// Express / plain-http adapter. Zero deps: parses its own JSON for /init and
// streams chunk bodies straight into the store, so it does not care whether
// `express.json()` is mounted. Mount it at a prefix:
//
//   app.use('/api/upload/chunked', chunkedUploadHandler({ store, auth, onComplete }))
//
// auth(req, res) → ownerId | null   (null → 401; send your own response if you prefer)
// onComplete(file, req, res) → json (file = store.complete() result)

const { ChunkError } = require('../store');

const MAX_JSON = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return resolve(req.body);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) {
        req.destroy();
        reject(new ChunkError(413, 'body_too_large', 'JSON body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new ChunkError(400, 'bad_json', 'Body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendError(res, err, log) {
  if (err instanceof ChunkError) return json(res, err.status, err.toJSON());
  if (log) log('chunked-upload: unexpected error', err);
  return json(res, 500, { error: 'Upload failed', code: 'internal' });
}

function chunkedUploadHandler(opts = {}) {
  const { store, onComplete } = opts;
  const auth = opts.auth || (async () => null);
  const log = opts.log || ((...a) => console.error(...a));
  if (!store) throw new Error('chunkedUploadHandler: `store` is required');
  if (typeof onComplete !== 'function') throw new Error('chunkedUploadHandler: `onComplete` is required');

  const ROUTES = [
    { method: 'POST', re: /^\/init\/?$/, fn: handleInit },
    { method: 'GET', re: /^\/([A-Za-z0-9_-]+)\/?$/, fn: handleStatus },
    { method: 'PUT', re: /^\/([A-Za-z0-9_-]+)\/(\d+)\/?$/, fn: handlePut },
    { method: 'POST', re: /^\/([A-Za-z0-9_-]+)\/complete\/?$/, fn: handleComplete },
    { method: 'DELETE', re: /^\/([A-Za-z0-9_-]+)\/?$/, fn: handleAbort },
  ];

  async function resolveOwner(req, res) {
    const owner = await auth(req, res);
    if (owner === null || owner === undefined) {
      json(res, 401, { error: 'Unauthorized', code: 'unauthorized' });
      return undefined;
    }
    return String(owner);
  }

  async function handleInit(req, res, _m, owner) {
    const body = await readJson(req);
    json(res, 200, await store.init(body, owner));
  }
  async function handleStatus(req, res, m, owner) {
    json(res, 200, await store.status(m[1], owner));
  }
  async function handlePut(req, res, m, owner) {
    const len = Number(req.headers['content-length']);
    const hint = Number.isInteger(len) ? { length: len } : {};
    json(res, 200, await store.putChunk(m[1], m[2], req, owner, hint));
  }
  async function handleComplete(req, res, m, owner) {
    const file = await store.complete(m[1], owner);
    let result;
    let failure;
    try {
      result = await onComplete(file, req, res);
    } catch (err) {
      failure = err;
    }
    // release before responding so the temp dir is gone by the time the client sees 200/500
    await file.release().catch(() => {});
    if (failure) throw failure;
    if (!res.headersSent) json(res, 200, result === undefined ? { ok: true } : result);
  }
  async function handleAbort(req, res, m, owner) {
    json(res, 200, await store.abort(m[1], owner));
  }

  return function chunkedUpload(req, res, next) {
    // express strips the mount path into req.path; plain http gives req.url
    const rawPath = typeof req.path === 'string' ? req.path : (req.url || '').split('?')[0];
    const route = ROUTES.find((r) => r.method === req.method && r.re.test(rawPath));
    if (!route) {
      if (typeof next === 'function') return next();
      return json(res, 404, { error: 'Not found', code: 'not_found' });
    }
    const m = route.re.exec(rawPath);
    (async () => {
      const owner = await resolveOwner(req, res);
      if (owner === undefined) return;
      await route.fn(req, res, m, owner);
    })().catch((err) => sendError(res, err, log));
  };
}

exports.chunkedUploadHandler = chunkedUploadHandler;
