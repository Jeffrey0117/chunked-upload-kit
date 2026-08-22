// 最小範例：node example.js
// 起一個 fastify server，然後用 kit 自己的 client 把 1 個 50MB 的隨機檔案以 4MB 分塊上傳上去。
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createChunkStore, registerChunkedUpload } = require('./index');

async function main() {
  const Fastify = require('fastify'); // devDependency — `npm i` first
  const app = Fastify({ logger: false });
  const store = createChunkStore({
    dir: path.join(os.tmpdir(), 'chunked-upload-kit-example'),
    defaultChunkSize: 4 * 1024 * 1024,
  });

  registerChunkedUpload(app, {
    prefix: '/api/upload/chunked',
    store,
    auth: (req) => (req.headers.authorization === 'Bearer demo' ? 'demo-user' : null),
    onComplete: async (file) => {
      // 真實專案在這裡把 file.path 搬進自己的儲存層；回傳值就是 HTTP 回應
      const stat = fs.statSync(file.path);
      return { ok: true, filename: file.filename, size: stat.size, sha256: file.sha256, owner: file.owner };
    },
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const endpoint = `http://127.0.0.1:${app.server.address().port}/api/upload/chunked`;
  console.log('server:', endpoint);

  const { uploadChunked } = await import('./client/index.mjs');
  const bytes = crypto.randomBytes(50 * 1024 * 1024);
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');

  const result = await uploadChunked(new Blob([bytes]), {
    endpoint,
    headers: { authorization: 'Bearer demo' },
    filename: 'demo.bin',
    sha256: expected, // server verifies
    concurrency: 4,
    onProgress: ({ percent }) => process.stdout.write(`\r  upload ${percent}%   `),
  });
  console.log('\nresult:', result);
  console.log('sha256 match:', result.sha256 === expected);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
