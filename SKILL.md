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
     onInit: (body, owner) => { if (overQuota(owner)) throw new ChunkError(413, "quota", "Storage full") }, // 上傳前就擋
     onComplete: (file, req) => finalizeUpload(file, req.completeBody),  // 跟單檔路由共用同一個落檔函式
   })
   ```
   express：`app.use('/api/upload/chunked', chunkedUploadHandler({ store, auth, onComplete }))`
3. **把既有上傳路由的「落檔」邏輯抽成一個函式**（quota 檢查、圖/影片/一般檔分支、回傳格式），單檔路由和 `onComplete` 都呼叫它 — 兩條路的回傳 JSON 才會同形，前端不用分兩套處理。
4. client：**有打包的專案（Next.js 等）直接 `import { uploadChunked } from 'chunked-upload-kit/client'`，不要抄檔**（coursebloom 抄過一份，kit 修了 bug 它沒跟到）。沒打包、直接丟檔案給瀏覽器的專案才把 `client/index.mjs` 複製到 `public/vendor/`，
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
- `meta` 放一般表單欄位（到期、相簿…）；**密碼這種機敏值放 `completeBody`**（只跟著最後一個 request 走，不落地到 session 的 meta.json）。
- **quota / 權限檢查放 `onInit`**，不要等到 `onComplete`（否則使用者傳完 500MB 才被拒，磁碟也白吃）。
- **把 `onEvent` 接到你的前端 log / beacon**：`ack-lost`（塊送完了、伺服器也收了，但瀏覽器沒拿到回應）、`chunk-recovered`、`chunk-retry`。使用者只會說「卡在 32%」，這幾個事件才看得出卡在哪。
- 失敗要不要續傳看 `err.resumable`：true（網路/5xx/abort）才留 `uploadId`；false（4xx）session 已經沒了，清掉 id 重來。

## 在家高速上傳（0.3.0）

服務架在家裡、經 Cloudflare tunnel 對外時，**人在家上傳反而最慢**：檔案要先出去 CF 再繞回來（實測 2.4 MB/s；走家裡網路 21.7 MB/s，約 9 倍）。

- 伺服器那半：CloudPipe 的 `lan-gateway`（`src/core/lan-gateway.js`）已經替所有專案開好 `https://<id>.lan.<網域>`：公開 DNS 指到家裡 IP、真憑證、轉給原本的服務。**專案本身不用改。**
- 前端：`uploadChunked(file, { endpoint: '/api/upload/chunked', lan: true, ... })`。上傳開始時問一次 `/__lan/ping`（1.5 秒內沒回就當不在家），在家就把位元組送去 LAN 網址，不在家一切照舊。結果記在 sessionStorage 5 分鐘。
- 自己寫的上傳（不用 uploadChunked）：`<script src="lan-probe.js">` 後 `const base = await LanProbe.probeLan(LanProbe.lanBaseFor(location.hostname))`，把 `(base || '') + '/upload'` 當網址。
- 地雷：
  - **endpoint 要是相對路徑**（`/api/...`）才會換；寫死完整網址就不會走家裡。
  - 登入要用 `Authorization` 標頭帶 token。**靠 cookie 登入的不會跨網域帶過去**，那種先改成帶 token 再接。
  - 只在**開始上傳時**問，不要一進頁面就問：Chrome 會跳一次「允許存取區域網路裝置？」，在上傳當下問才有意義。
  - 頁面本身留在公開網址，只有上傳的位元組換路，所以上傳完的回應、之後的頁面都不受影響。

## 地雷

- **npm 上的 `chunked-upload-kit` 不是這個 kit**（別人 2026-11-20 註冊的同名套件）。依賴一律寫 `github:Jeffrey0117/chunked-upload-kit`，絕對不要寫成版本號（`^0.2.0`），不然裝到的是陌生人的程式。

- **「卡在 N% 不動，N 剛好是前幾塊的大小」＝回應掉了，不是伺服器沒收到**（2026-11-25 pokkit，iPhone 走 http 區網直連：伺服器三塊都存好也回了 200，手機一個回應都沒拿到，等滿 120 秒重送同樣三塊，無限循環）。client 0.2.0 起塊送完 5 秒沒回應會主動問伺服器（`ackProbeMs`），有收到就往下傳；失敗重送前也會先問。**複製到 `public/vendor/` 的 client 要跟著更新**，舊副本沒有這段。

- **chunkSize / maxChunkSize 超過 proxy 上限整套白做**（CF 非 Enterprise = 100MB/request）。預設 32MB 上限是刻意的。
- fastify 的 `application/octet-stream` parser 是 plugin 內部註冊（encapsulated），host app 不會被改行為；但如果你把 `registerChunkedUpload` 包在 `fastify-plugin` 裡就會外洩 — 別包。
- **`onComplete` 要「回傳物件」，不要自己 `reply.send()` / `res.json()`**：adapter 是先 release session 再送回應；你自己先送，client 會在 temp 還沒清掉時就收到 200（測試一定抓到）。要改 status code 用 `reply.status(400)` 然後 return body（fastify 會沿用）。
- `onComplete` 拿到的 `file.path` 在回傳後就被刪；要保留就在 `onComplete` 裡 rename/copy 走，別把 path 存進 DB。
- 跑在 PM2/Windows：session 目錄放在資料目錄裡（`data/chunks`），別放 `os.tmpdir()`（部署會清、跨槽 rename 會變 copy）。
- 本地 SQLite / 本地檔案的專案（pokkit、lurlhub）**不能開 cloudpipe `slotDeploy`**，chunks 目錄也一樣會被刷掉 — 這不是 kit 的問題，是部署模式。
- rate limit：一個 500MB 檔 = 32 個 PUT；全域 rate limit 設太緊（<100/min）會把大檔打成 429（client 會退避重試，但變慢）。
- **經過 proxy 的無 body POST 會被改寫成 chunked 且沒 content-type**（CF → tunnel → cloudpipe 實測）→ fastify 415。adapter 已容忍，client 也一律送 JSON；自己寫 curl 測試記得 `-H "Content-Type: application/json" -d "{}"`。
- `onComplete` 把整檔讀進記憶體的話，自己加 semaphore（pokkit 用 2 slots）— 10 個 500MB 同時 complete = 5GB RAM。
