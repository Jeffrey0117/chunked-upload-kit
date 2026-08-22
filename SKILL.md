---
name: chunked-upload-kit
description: 任何「上傳大檔（影片/壓縮包/>50MB）到自家服務」或「上傳卡在個位數 %、Cloudflare 回 413」的需求，直接套這個 kit，不要再寫單一 multipart POST。
---

# chunked-upload-kit — 打法

**把大檔切成 <100MB 的塊、平行送、伺服器重組。** 零依賴、fastify/express adapter、瀏覽器+Node 同一個 client。

## 何時觸發

- 使用者要上傳影片 / 大檔到自架服務（pokkit、lurlhub、duk、dropkit…）。
- 症狀：「上傳卡在 4%」「進度條不動」「Network error」「413 Payload Too Large（署名 cloudflare）」。
  → **那是 Cloudflare 邊緣擋 >100MB body，request 根本沒到 origin**，不要去查 tunnel / proxy / app log，直接上這個 kit。
- 既有單一 `multipart` 路由已經在用、只是大檔會死 → 保留舊路由給小檔，大檔走 chunked（pokkit 的作法）。

## 接線（照抄能跑）

1. `npm i github:Jeffrey0117/chunked-upload-kit`
2. server（fastify）：
   ```js
   import { createChunkStore, registerChunkedUpload } from 'chunked-upload-kit'
   const store = createChunkStore({ dir: join(dataDir, 'chunks'), maxFileSize: config.maxFileSize })
   store.startSweeper()
   registerChunkedUpload(app, {
     prefix: '/api/upload/chunked',
     store,
     auth: (req, reply) => requireAuth(req, reply)?.userId ?? null,   // 你既有的 auth；null → 401
     onComplete: (file, req) => finalizeUpload(file),                    // 跟單檔路由共用同一個落檔函式
   })
   ```
   express：`app.use('/api/upload/chunked', chunkedUploadHandler({ store, auth, onComplete }))`
3. **把既有上傳路由的「落檔」邏輯抽成一個函式**（quota 檢查、圖/影片/一般檔分支、回傳格式），單檔路由和 `onComplete` 都呼叫它 — 兩條路的回傳 JSON 才會同形，前端不用分兩套處理。
4. client：把 `client/index.mjs` 複製到 `public/vendor/`（或 bundler import），
   ```html
   <script type="module">
     import { uploadChunked } from './vendor/chunked-upload-client.mjs'
     window.ChunkedUpload = { uploadChunked }
   </script>
   ```
   在原本的上傳函式裡：`file.size > CHUNK_THRESHOLD ? ChunkedUpload.uploadChunked(file, {...}) : 舊 XHR`。
5. `npm test` 跑 kit 的測試；自己的專案用 `app.inject()` 寫 init→put→complete 一條 happy path + 403/409 兩條錯誤。

## 模式與文案

- **門檻不要設太低**：小檔走單一 request 最便宜；`CHUNK_THRESHOLD` 取 32~64MB，`chunkSize` 16MB、`maxChunkSize` 32MB（CF 上限 100MB 留餘裕）。
- 進度條用 `onProgress.percent`；失敗 toast 用 `err.message`（伺服器的 `error` 字串已經是給人看的），`err.code` 決定要不要自動重試（`network/timeout` 重試，其他不要）。
- 失敗時留著 `err.uploadId`，「重試」按鈕帶 `uploadId` 呼叫 → 只補缺的塊，使用者感覺是「續傳」。
- `onComplete` 回什麼，client 就拿到什麼 — 回和舊路由一模一樣的形狀，前端既有的成功處理直接複用。
- `meta` 放表單欄位（密碼、到期、相簿…），別另開 API。

## 地雷

- **chunkSize / maxChunkSize 超過 proxy 上限整套白做**（CF 非 Enterprise = 100MB/request）。預設 32MB 上限是刻意的。
- fastify 的 `application/octet-stream` parser 是 plugin 內部註冊（encapsulated），host app 不會被改行為；但如果你把 `registerChunkedUpload` 包在 `fastify-plugin` 裡就會外洩 — 別包。
- **`onComplete` 要「回傳物件」，不要自己 `reply.send()` / `res.json()`**：adapter 是先 release session 再送回應；你自己先送，client 會在 temp 還沒清掉時就收到 200（測試一定抓到）。要改 status code 用 `reply.status(400)` 然後 return body（fastify 會沿用）。
- `onComplete` 拿到的 `file.path` 在回傳後就被刪；要保留就在 `onComplete` 裡 rename/copy 走，別把 path 存進 DB。
- 跑在 PM2/Windows：session 目錄放在資料目錄裡（`data/chunks`），別放 `os.tmpdir()`（部署會清、跨槽 rename 會變 copy）。
- 本地 SQLite / 本地檔案的專案（pokkit、lurlhub）**不能開 cloudpipe `slotDeploy`**，chunks 目錄也一樣會被刷掉 — 這不是 kit 的問題，是部署模式。
- rate limit：一個 500MB 檔 = 32 個 PUT；全域 rate limit 設太緊（<100/min）會把大檔打成 429（client 會退避重試，但變慢）。
