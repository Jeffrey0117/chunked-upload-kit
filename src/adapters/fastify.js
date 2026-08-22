'use strict';
// Fastify adapter. Registered as an encapsulated plugin so the raw
// `application/octet-stream` parser it needs never leaks into the host app.
//
//   registerChunkedUpload(app, {
//     prefix: '/api/upload/chunked',
//     store,                                  // createChunkStore(...)
//     auth: async (req, reply) => ownerId,    // return null/undefined → 401 (or send your own reply)
//     onComplete: async (file, req, reply) => ({ ...json }),  // file = store.complete() result
//   })

const { ChunkError } = require('../store');

function sendError(reply, err, log) {
  if (err instanceof ChunkError) {
    return reply.code(err.status).send(err.toJSON());
  }
  if (log) log.error({ err }, 'chunked-upload: unexpected error');
  return reply.code(500).send({ error: 'Upload failed', code: 'internal' });
}

async function chunkedUploadPlugin(app, opts) {
  const { store, onComplete } = opts;
  const auth = opts.auth || (async () => null);
  if (!store) throw new Error('chunkedUploadPlugin: `store` is required');
  if (typeof onComplete !== 'function') throw new Error('chunkedUploadPlugin: `onComplete` is required');

  // Raw stream for chunk bodies. Scoped to this plugin by fastify encapsulation.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  async function resolveOwner(req, reply) {
    const owner = await auth(req, reply);
    if (owner === null || owner === undefined) {
      if (!reply.sent) reply.code(401).send({ error: 'Unauthorized', code: 'unauthorized' });
      return undefined;
    }
    return String(owner);
  }

  app.post('/init', async (req, reply) => {
    const owner = await resolveOwner(req, reply);
    if (owner === undefined) return reply;
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
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
    if (owner === undefined) return reply;
    try {
      const len = Number(req.headers['content-length']);
      const hint = Number.isInteger(len) ? { length: len } : {};
      const body = req.body;
      const source = Buffer.isBuffer(body) || (body && typeof body.pipe === 'function') ? body : Buffer.alloc(0);
      return await store.putChunk(req.params.uploadId, req.params.index, source, owner, hint);
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post('/:uploadId/complete', async (req, reply) => {
    const owner = await resolveOwner(req, reply);
    if (owner === undefined) return reply;
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
    if (reply.sent) return reply;
    return result === undefined ? { ok: true } : result;
  });

  app.delete('/:uploadId', async (req, reply) => {
    const owner = await resolveOwner(req, reply);
    if (owner === undefined) return reply;
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
