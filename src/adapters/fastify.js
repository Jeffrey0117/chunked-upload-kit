'use strict';
// Fastify adapter. Registered as an encapsulated plugin so the raw
// `application/octet-stream` parser it needs never leaks into the host app.
//
//   registerChunkedUpload(app, {
//     prefix: '/api/upload/chunked',
//     store,                                   // createChunkStore(...)
//     auth: async (req, reply) => ownerId,     // null/undefined → 401; `false` → "I already replied"
//     onInit: async (body, owner, req, reply) => {},  // optional: throw ChunkError to refuse before any byte lands
//     onComplete: async (file, req, reply) => ({ ...json }),  // file = store.complete() result; RETURN, don't send
//   })

const { ChunkError } = require('../store');

function sendError(reply, err, log) {
  if (err instanceof ChunkError) {
    return reply.code(err.status).send(err.toJSON());
  }
  if (log) log.error({ err }, 'chunked-upload: unexpected error');
  return reply.code(500).send({ error: 'Upload failed', code: 'internal' });
}

// Let the unread request body drain so an early error reply (401/403/400 while
// a 32MB chunk is still arriving) reaches the client instead of a socket reset.
function drain(req) {
  const raw = req.raw;
  if (raw && !raw.readableEnded && !raw.destroyed) raw.resume();
}

const alreadyReplied = (reply) => reply.sent || (reply.raw && reply.raw.headersSent);

async function chunkedUploadPlugin(app, opts) {
  const { store, onComplete, onInit } = opts;
  const auth = opts.auth || (async () => null);
  if (!store) throw new Error('chunkedUploadPlugin: `store` is required');
  if (typeof onComplete !== 'function') throw new Error('chunkedUploadPlugin: `onComplete` is required');

  // Raw stream for chunk bodies. Scoped to this plugin by fastify encapsulation.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // Proxies (Cloudflare → tunnel → local proxy) often re-frame a body-less POST
  // as `transfer-encoding: chunked` with no content-type; fastify would 415 it.
  // Treat "no content-type" as a raw stream we simply ignore.
  app.addHook('onRequest', async (req) => {
    if (!req.headers['content-type'] && (req.method === 'POST' || req.method === 'DELETE')) {
      req.headers['content-type'] = 'application/octet-stream';
    }
  });

  async function resolveOwner(req, reply) {
    const owner = await auth(req, reply);
    if (owner === false || alreadyReplied(reply)) return undefined;
    if (owner === null || owner === undefined) {
      reply.code(401).send({ error: 'Unauthorized', code: 'unauthorized' });
      return undefined;
    }
    return String(owner);
  }

  // JSON body when the client sent one; {} for an empty/raw body.
  function jsonBody(req) {
    const b = req.body;
    if (b && typeof b === 'object' && !Buffer.isBuffer(b) && typeof b.pipe !== 'function') return b;
    if (b && typeof b.pipe === 'function') b.resume();
    return {};
  }

  app.post('/init', async (req, reply) => {
    const owner = await resolveOwner(req, reply);
    if (owner === undefined) return reply;
    try {
      const body = jsonBody(req);
      if (onInit) await onInit(body, owner, req, reply);
      if (alreadyReplied(reply)) return reply;
      return await store.init(body, owner);
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.get('/:uploadId', async (req, reply) => {
    const owner = await resolveOwner(req, reply);
    if (owner === undefined) return reply;
    try {
      return await store.status(req.params.uploadId, owner);
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.put('/:uploadId/:index', async (req, reply) => {
    const owner = await resolveOwner(req, reply);
    if (owner === undefined) {
      drain(req);
      return reply;
    }
    try {
      const len = Number(req.headers['content-length']);
      const hint = Number.isInteger(len) ? { length: len } : {};
      const body = req.body;
      const source = Buffer.isBuffer(body) || (body && typeof body.pipe === 'function') ? body : Buffer.alloc(0);
      return await store.putChunk(req.params.uploadId, req.params.index, source, owner, hint);
    } catch (err) {
      drain(req);
      return sendError(reply, err, req.log);
    }
  });

  app.post('/:uploadId/complete', async (req, reply) => {
    const owner = await resolveOwner(req, reply);
    if (owner === undefined) return reply;
    req.completeBody = jsonBody(req);
    let file;
    try {
      file = await store.complete(req.params.uploadId, owner);
    } catch (err) {
      return sendError(reply, err, req.log);
    }
    // Release BEFORE responding: fastify flushes the reply as soon as the handler
    // returns/sends, and callers may legitimately expect the temp dir to be gone
    // once they have the response.
    let result;
    let failure;
    try {
      result = await onComplete(file, req, reply);
    } catch (err) {
      failure = err;
    }
    await file.release().catch(() => {});
    if (failure) return sendError(reply, failure, req.log);
    if (alreadyReplied(reply)) return reply;
    return result === undefined ? { ok: true } : result;
  });

  app.delete('/:uploadId', async (req, reply) => {
    const owner = await resolveOwner(req, reply);
    if (owner === undefined) return reply;
    jsonBody(req);
    try {
      return await store.abort(req.params.uploadId, owner);
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });
}

function registerChunkedUpload(app, opts = {}) {
  const { prefix, ...rest } = opts;
  return app.register(chunkedUploadPlugin, { ...rest, prefix: prefix || '/' });
}

exports.chunkedUploadPlugin = chunkedUploadPlugin;
exports.registerChunkedUpload = registerChunkedUpload;
