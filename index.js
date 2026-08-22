'use strict';
// ============================================================================
// chunked-upload-kit — chunked / resumable uploads that survive body-size caps
// (Cloudflare 100MB, nginx client_max_body_size, serverless limits…).
// ----------------------------------------------------------------------------
// Zero runtime deps. Server side: `createChunkStore` (framework-agnostic core)
// + thin adapters for fastify and express. Client side: `client/index.mjs`
// (browser + Node, ESM).
// ============================================================================

const { createChunkStore, ChunkError, sanitizeFilename } = require('./src/store');
const { registerChunkedUpload, chunkedUploadPlugin } = require('./src/adapters/fastify');
const { chunkedUploadHandler } = require('./src/adapters/express');

exports.createChunkStore = createChunkStore;
exports.ChunkError = ChunkError;
exports.sanitizeFilename = sanitizeFilename;
exports.registerChunkedUpload = registerChunkedUpload;
exports.chunkedUploadPlugin = chunkedUploadPlugin;
exports.chunkedUploadHandler = chunkedUploadHandler;
