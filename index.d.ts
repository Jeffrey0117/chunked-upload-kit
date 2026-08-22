/// <reference types="node" />
import type { Readable } from 'node:stream'

export interface ChunkStoreOptions {
  /** Directory for in-flight sessions (created if missing). Required. */
  dir: string
  /** Chunk size used when the client does not ask for one. Default 16 MiB. */
  defaultChunkSize?: number
  /** Largest chunk a client may request. Keep well under your proxy's body cap. Default 32 MiB. */
  maxChunkSize?: number
  /** Smallest chunk a client may request. Default 1024. */
  minChunkSize?: number
  /** Largest whole file accepted at init. Default 2 GiB. */
  maxFileSize?: number
  /** Upper bound on chunks per upload. Default 4096. */
  maxChunks?: number
  /** In-flight sessions one owner may hold at once (429 beyond). Default 16. */
  maxSessionsPerOwner?: number
  /** Sessions older than this are removed by sweep(). Default 24h. */
  ttlMs?: number
  /** Optional logger for sweep messages. */
  log?: (msg: string) => void
}

export interface InitInput {
  filename: string
  size: number
  mime?: string
  chunkSize?: number
  /** Hex sha256 of the whole file; verified on complete when given. */
  sha256?: string
  /** Arbitrary JSON (≤16 KiB) handed back to onComplete untouched. */
  meta?: Record<string, unknown>
}

export interface InitResult {
  uploadId: string
  chunkSize: number
  totalChunks: number
  received: number[]
}

export interface SessionStatus {
  uploadId: string
  filename: string
  size: number
  mime: string
  chunkSize: number
  totalChunks: number
  received: number[]
}

export interface PutChunkResult {
  received: number[]
  done: boolean
}

export interface CompletedUpload {
  uploadId: string
  /** Absolute path of the assembled file. Valid until release(). */
  path: string
  filename: string
  mime: string
  size: number
  /** Hex sha256 of the assembled bytes (always computed). */
  sha256: string
  meta: Record<string, unknown> | null
  owner: string | null
  /** Delete the session directory (and the assembled file). */
  release(): Promise<void>
}

export interface ChunkStore {
  readonly dir: string
  readonly limits: Required<Pick<ChunkStoreOptions, 'defaultChunkSize' | 'maxChunkSize' | 'minChunkSize' | 'maxFileSize' | 'maxChunks' | 'maxSessionsPerOwner' | 'ttlMs'>>
  init(input: InitInput, owner?: string | null): Promise<InitResult>
  status(uploadId: string, owner?: string | null): Promise<SessionStatus>
  putChunk(uploadId: string, index: number | string, source: Buffer | Readable, owner?: string | null, hint?: { length?: number }): Promise<PutChunkResult>
  complete(uploadId: string, owner?: string | null): Promise<CompletedUpload>
  abort(uploadId: string, owner?: string | null): Promise<{ ok: true }>
  /** Remove expired sessions. Returns how many were removed. */
  sweep(now?: number): Promise<number>
  /** Run sweep() shortly after boot and then every intervalMs (default 1h). Returns a stop function. */
  startSweeper(intervalMs?: number): () => void
}

export class ChunkError extends Error {
  status: number
  code: string
  extra: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>)
  toJSON(): { error: string; code: string } & Record<string, unknown>
}

export function createChunkStore(opts: ChunkStoreOptions): ChunkStore
export function sanitizeFilename(name: unknown): string

// ── fastify adapter ──────────────────────────────────────────────────────────
export interface FastifyAdapterOptions<Req = any, Reply = any> {
  prefix?: string
  store: ChunkStore
  /** Return the owner id; null/undefined → 401; `false` → "I already sent a reply". */
  auth?: (req: Req, reply: Reply) => string | null | undefined | false | Promise<string | null | undefined | false>
  /** Runs before a session is created — throw a ChunkError to refuse (quota, permissions) before any byte lands. */
  onInit?: (body: InitInput, owner: string, req: Req, reply: Reply) => void | Promise<void>
  /**
   * Called with the assembled file; RETURN the response body (set the status via reply.status(n)
   * but do not send — the adapter releases the session first). The JSON body the client sent
   * with /complete is on `req.completeBody`.
   */
  onComplete: (file: CompletedUpload, req: Req & { completeBody?: Record<string, unknown> }, reply: Reply) => unknown | Promise<unknown>
}
export function registerChunkedUpload(app: any, opts: FastifyAdapterOptions): any
export function chunkedUploadPlugin(app: any, opts: Omit<FastifyAdapterOptions, 'prefix'>): Promise<void>

// ── express / plain http adapter ─────────────────────────────────────────────
export interface ExpressAdapterOptions<Req = any, Res = any> {
  store: ChunkStore
  auth?: (req: Req, res: Res) => string | null | undefined | false | Promise<string | null | undefined | false>
  onInit?: (body: InitInput, owner: string, req: Req, res: Res) => void | Promise<void>
  onComplete: (file: CompletedUpload, req: Req & { completeBody?: Record<string, unknown> }, res: Res) => unknown | Promise<unknown>
  log?: (...args: unknown[]) => void
}
export function chunkedUploadHandler(opts: ExpressAdapterOptions): (req: any, res: any, next?: (err?: unknown) => void) => void
