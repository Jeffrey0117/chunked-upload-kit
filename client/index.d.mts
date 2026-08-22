export interface UploadProgress {
  loaded: number
  total: number
  percent: number
  uploadId: string
}

export interface UploadOptions {
  /** Base URL of the chunked upload routes, e.g. '/api/upload/chunked'. */
  endpoint: string
  headers?: Record<string, string>
  /** Called before every request; wins over `headers`. Use for refreshing tokens. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>
  /** Requested chunk size (server may clamp/reject). Omit to use the server default. */
  chunkSize?: number
  /** Parallel chunk PUTs. Default 3. */
  concurrency?: number
  /** Retries per chunk on network/408/429/5xx. Default 3. */
  retries?: number
  retryDelayMs?: number
  /** Per-chunk XHR timeout in ms (browser only). Default 120000; 0 disables. */
  chunkTimeoutMs?: number
  onProgress?: (p: UploadProgress) => void
  signal?: AbortSignal
  /** Arbitrary JSON stored with the session (on disk until complete) and passed to onComplete as file.meta. */
  meta?: Record<string, unknown>
  /** JSON sent only with the final /complete request (req.completeBody) — use for secrets like passwords. */
  completeBody?: Record<string, unknown>
  /** Hex sha256 of the file for server-side verification. */
  sha256?: string
  /** Override file.name / file.type. */
  filename?: string
  mime?: string
  /** Resume an earlier session instead of creating a new one. */
  uploadId?: string
  fetch?: typeof fetch
  /** Use XMLHttpRequest for chunk PUTs (default: when available — gives real upload progress). */
  useXhr?: boolean
}

export class UploadError extends Error {
  status: number
  code: string
  body: unknown
  /** Set whenever a session exists. */
  uploadId: string | null
  /** true when the session should still exist server-side (network/5xx/abort) — keep uploadId to resume; false → start over. */
  resumable: boolean
}

/** Upload a Blob/File in chunks. Resolves with the server's /complete JSON. */
export function uploadChunked<T = any>(file: Blob, opts: UploadOptions): Promise<T>

/** Best-effort DELETE of an unfinished session. Never throws. */
export function abortUpload(uploadId: string, opts: Pick<UploadOptions, 'endpoint' | 'headers' | 'getHeaders' | 'fetch'>): Promise<boolean>
