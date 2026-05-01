/**
 * Chunked media upload for the QQ Open Platform.
 *
 * ## Flow (mirrors the upload sequence diagram)
 *
 * 1. `upload_prepare` — submit file metadata + (md5 / sha1 / md5_10m) hashes,
 *    receive `{ upload_id, block_size, parts[], concurrency?, retry_timeout? }`.
 * 2. For every part (parallelized under a bounded concurrency):
 *    a. Read the part bytes (stream from disk or slice in-memory buffer).
 *    b. PUT the bytes to the pre-signed COS URL.
 *    c. POST `upload_part_finish { upload_id, part_index, block_size, md5 }`,
 *       retrying under {@link PART_FINISH_RETRY_POLICY} + the persistent
 *       retry loop for {@link PART_FINISH_RETRYABLE_CODES}.
 * 3. POST `complete_upload { upload_id }` — returns `{ file_uuid, file_info,
 *    ttl }` identical to the one-shot path.
 * 4. If `upload_prepare` returns {@link UPLOAD_PREPARE_FALLBACK_CODE}
 *    (`40093002` — daily upload quota exceeded), throw
 *    {@link UploadDailyLimitExceededError} so the upper layer can surface a
 *    user-facing message. The dispatcher is responsible for the fallback
 *    (there is no server path that will accept the file at this point).
 *
 * ## Why a class
 *
 * Mirrors {@link MediaApi}: injects {@link ApiClient}, {@link TokenManager},
 * the upload cache adapter, an optional filename sanitizer, and a logger.
 * Keeping the client singleton plumbing consistent means only one place
 * manages UA / baseUrl / file-upload timeouts.
 *
 * ## Upload cache integration
 *
 * Chunked uploads participate in the same `file_info` cache as
 * {@link MediaApi.uploadMedia}. The cache key is derived from the full-file
 * md5 (already computed for `upload_prepare`) so repeat sends of the same
 * large file hit the cache before we even talk to `upload_prepare`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { MediaSource } from "../messaging/media-source.js";
import {
  ApiError,
  MediaFileType,
  type ChatScope,
  type EngineLogger,
  type UploadMediaResponse,
  type UploadPart,
  type UploadPrepareHashes,
  type UploadPrepareResponse,
} from "../types.js";
import { formatFileSize } from "../utils/file-utils.js";
import type { ApiClient } from "./api-client.js";
import type { SanitizeFileNameFn, UploadCacheAdapter } from "./media.js";
import {
  buildPartFinishPersistentPolicy,
  COMPLETE_UPLOAD_RETRY_POLICY,
  PART_FINISH_RETRY_POLICY,
  UPLOAD_PREPARE_FALLBACK_CODE,
  withRetry,
} from "./retry.js";
import { uploadCompletePath, uploadPartFinishPath, uploadPreparePath } from "./routes.js";
import type { TokenManager } from "./token.js";

// ============ Public types ============

/**
 * Raised when `upload_prepare` returns {@link UPLOAD_PREPARE_FALLBACK_CODE}
 * (40093002). Carries enough context for the outbound layer to render a
 * user-facing fallback message (file name, size, and the originating
 * local path when available).
 */
export class UploadDailyLimitExceededError extends Error {
  override readonly name = "UploadDailyLimitExceededError";

  constructor(
    /** Original local file path, or `"<buffer>"` when uploading an in-memory buffer. */
    public readonly filePath: string,
    /** File size in bytes. */
    public readonly fileSize: number,
    /** Original error message from the server. */
    originalMessage: string,
  ) {
    super(originalMessage);
  }
}

/** Chunked-upload progress callback payload. */
interface ChunkedUploadProgress {
  completedParts: number;
  totalParts: number;
  uploadedBytes: number;
  totalBytes: number;
}

/** Per-call options for {@link ChunkedMediaApi.uploadChunked}. */
interface UploadChunkedOptions {
  scope: ChatScope;
  targetId: string;
  fileType: MediaFileType;
  source: MediaSource;
  creds: { appId: string; clientSecret: string };
  /**
   * Optional filename override. When omitted, derived from `source.path`
   * (localPath) / `source.fileName` (buffer) / `"file"` (fallback).
   */
  fileName?: string;
  /** Progress callback invoked after every successful part. */
  onProgress?: (progress: ChunkedUploadProgress) => void;
  /** Log prefix — defaults to `"[qqbot:chunked-upload]"`. */
  logPrefix?: string;
}

/** Configuration for the {@link ChunkedMediaApi} constructor. */
interface ChunkedMediaApiConfig {
  logger?: EngineLogger;
  /** Upload cache adapter (optional; omit to disable caching). */
  uploadCache?: UploadCacheAdapter;
  /** File name sanitizer — defaults to identity. */
  sanitizeFileName?: SanitizeFileNameFn;
}

// ============ Tuning constants ============

/** Default concurrency when the server does not specify one. */
const DEFAULT_CONCURRENT_PARTS = 1;

/** Hard cap on per-upload concurrency regardless of what the server returns. */
const MAX_CONCURRENT_PARTS = 10;

/**
 * Upper bound on the persistent-retry window for `upload_part_finish`.
 *
 * The server may suggest `retry_timeout` via `upload_prepare` — we honor
 * it but clamp to 10 minutes so a runaway server can't hold the caller
 * hostage.
 */
const MAX_PART_FINISH_RETRY_TIMEOUT_MS = 10 * 60 * 1000;

/** Per-part PUT timeout (5 minutes). Matches the low-bandwidth tolerance. */
const PART_UPLOAD_TIMEOUT_MS = 300_000;

/**
 * Boundary used by `md5_10m` — first 10,002,432 bytes.
 *
 * Files smaller than this return the whole-file md5 for `md5_10m` (per the
 * server contract).
 */
const MD5_10M_SIZE = 10_002_432;

// ============ Class ============

/**
 * Chunked upload module. Stateless across calls — see
 * {@link ChunkedMediaApi.uploadChunked} for the main entry.
 */
export class ChunkedMediaApi {
  private readonly client: ApiClient;
  private readonly tokenManager: TokenManager;
  private readonly logger?: EngineLogger;
  private readonly cache?: UploadCacheAdapter;
  private readonly sanitize: SanitizeFileNameFn;

  constructor(client: ApiClient, tokenManager: TokenManager, config: ChunkedMediaApiConfig = {}) {
    this.client = client;
    this.tokenManager = tokenManager;
    this.logger = config.logger;
    this.cache = config.uploadCache;
    this.sanitize = config.sanitizeFileName ?? ((n) => n);
  }

  /**
   * Upload a {@link MediaSource} via the chunked endpoint. Only `localPath`
   * and `buffer` sources are accepted — `url` / `base64` must fall through
   * to {@link MediaApi.uploadMedia}.
   *
   * @throws {UploadDailyLimitExceededError} when `upload_prepare` returns
   *   {@link UPLOAD_PREPARE_FALLBACK_CODE}.
   */
  async uploadChunked(opts: UploadChunkedOptions): Promise<UploadMediaResponse> {
    const prefix = opts.logPrefix ?? "[qqbot:chunked-upload]";

    // 1. Resolve input: size + local path (or temp buffer handle).
    const input = resolveSource(opts.source, opts.fileName);

    const displayName = input.fileName;
    const fileSize = input.size;
    const pathLabel = input.kind === "localPath" ? input.path : "<buffer>";

    this.logger?.info?.(
      `${prefix} Start: file=${displayName} size=${formatFileSize(fileSize)} type=${opts.fileType}`,
    );

    // 2. Compute md5 / sha1 / md5_10m. Identical for buffer and localPath,
    // but the localPath path streams so it never has to materialize the
    // whole file twice.
    const hashes = await computeHashes(input);
    this.logger?.debug?.(
      `${prefix} hashes: md5=${hashes.md5} sha1=${hashes.sha1} md5_10m=${hashes.md5_10m}`,
    );

    // 3. Upload-cache fast path: the md5 hash is already a strong content
    // identifier, so we can short-circuit before even calling upload_prepare.
    if (this.cache) {
      const cached = this.cache.get(hashes.md5, opts.scope, opts.targetId, opts.fileType);
      if (cached) {
        this.logger?.info?.(
          `${prefix} cache HIT (md5=${hashes.md5.slice(0, 8)}) — skipping chunked upload`,
        );
        return { file_uuid: "", file_info: cached, ttl: 0 };
      }
    }

    // 4. upload_prepare.
    const fileNameForPrepare =
      opts.fileType === MediaFileType.FILE ? this.sanitize(displayName) : displayName;
    const prepareResp = await this.callUploadPrepare(
      opts,
      fileNameForPrepare,
      fileSize,
      hashes,
      pathLabel,
    );

    const { upload_id, parts } = prepareResp;
    const block_size = prepareResp.block_size;
    const maxConcurrent = Math.min(
      prepareResp.concurrency ? prepareResp.concurrency : DEFAULT_CONCURRENT_PARTS,
      MAX_CONCURRENT_PARTS,
    );
    const retryTimeoutMs = prepareResp.retry_timeout
      ? Math.min(prepareResp.retry_timeout * 1000, MAX_PART_FINISH_RETRY_TIMEOUT_MS)
      : undefined;

    this.logger?.info?.(
      `${prefix} prepared: upload_id=${upload_id} block=${formatFileSize(block_size)} parts=${parts.length} concurrency=${maxConcurrent}`,
    );

    // 5. Upload every part. Concurrency is per-upload, not global.
    let completedParts = 0;
    let uploadedBytes = 0;

    const uploadPart = async (part: UploadPart): Promise<void> => {
      const partIndex = part.index; // 1-based.
      const offset = (partIndex - 1) * block_size;
      const length = Math.min(block_size, fileSize - offset);

      const partBuffer = await readPart(input, offset, length);
      const md5Hex = crypto.createHash("md5").update(partBuffer).digest("hex");

      this.logger?.debug?.(
        `${prefix} part ${partIndex}/${parts.length}: ${formatFileSize(length)} offset=${offset} md5=${md5Hex}`,
      );

      // 5a. PUT to pre-signed COS URL.
      await putToPresignedUrl(
        part.presigned_url,
        partBuffer,
        partIndex,
        parts.length,
        this.logger,
        prefix,
      );

      // 5b. upload_part_finish — fetch a fresh token each time to defend
      // against long uploads exceeding the token TTL.
      await this.callUploadPartFinish(opts, upload_id, partIndex, length, md5Hex, retryTimeoutMs);

      completedParts++;
      uploadedBytes += length;
      this.logger?.info?.(
        `${prefix} part ${partIndex}/${parts.length} done (${completedParts}/${parts.length})`,
      );

      opts.onProgress?.({
        completedParts,
        totalParts: parts.length,
        uploadedBytes,
        totalBytes: fileSize,
      });
    };

    try {
      await runWithConcurrency(
        parts.map((part) => () => uploadPart(part)),
        maxConcurrent,
      );
    } finally {
      // If the input opened a buffered read stream we don't keep state,
      // but localPath readers open / close the file per-part so there
      // is nothing to unwind here. Kept as a seam for future streaming
      // optimizations.
    }

    this.logger?.info?.(`${prefix} all parts uploaded, completing...`);

    // 6. complete_upload.
    const result = await this.callCompleteUpload(opts, upload_id);
    this.logger?.info?.(`${prefix} completed: file_uuid=${result.file_uuid} ttl=${result.ttl}s`);

    // 7. Populate the shared upload cache so subsequent sends skip re-uploading.
    if (this.cache && result.file_info && result.ttl > 0) {
      this.cache.set(
        hashes.md5,
        opts.scope,
        opts.targetId,
        opts.fileType,
        result.file_info,
        result.file_uuid,
        result.ttl,
      );
    }

    return result;
  }

  // -------- Internal call wrappers --------

  private async callUploadPrepare(
    opts: UploadChunkedOptions,
    fileName: string,
    fileSize: number,
    hashes: UploadPrepareHashes,
    pathLabel: string,
  ): Promise<UploadPrepareResponse> {
    const token = await this.tokenManager.getAccessToken(opts.creds.appId, opts.creds.clientSecret);
    const path = uploadPreparePath(opts.scope, opts.targetId);
    try {
      return await this.client.request<UploadPrepareResponse>(
        token,
        "POST",
        path,
        {
          file_type: opts.fileType,
          file_name: fileName,
          file_size: fileSize,
          md5: hashes.md5,
          sha1: hashes.sha1,
          md5_10m: hashes.md5_10m,
        },
        { uploadRequest: true },
      );
    } catch (err) {
      if (err instanceof ApiError && err.bizCode === UPLOAD_PREPARE_FALLBACK_CODE) {
        throw new UploadDailyLimitExceededError(pathLabel, fileSize, err.message);
      }
      throw err;
    }
  }

  private async callUploadPartFinish(
    opts: UploadChunkedOptions,
    uploadId: string,
    partIndex: number,
    blockSize: number,
    md5: string,
    retryTimeoutMs?: number,
  ): Promise<void> {
    const persistentPolicy = buildPartFinishPersistentPolicy(retryTimeoutMs);
    const path = uploadPartFinishPath(opts.scope, opts.targetId);
    await withRetry(
      async () => {
        // Refresh the token on every attempt — the token may be expired by
        // the time we reach the tail of a long upload.
        const token = await this.tokenManager.getAccessToken(
          opts.creds.appId,
          opts.creds.clientSecret,
        );
        return this.client.request(
          token,
          "POST",
          path,
          {
            upload_id: uploadId,
            part_index: partIndex,
            block_size: blockSize,
            md5,
          },
          { uploadRequest: true },
        );
      },
      PART_FINISH_RETRY_POLICY,
      persistentPolicy,
      this.logger,
    );
  }

  private async callCompleteUpload(
    opts: UploadChunkedOptions,
    uploadId: string,
  ): Promise<UploadMediaResponse> {
    const path = uploadCompletePath(opts.scope, opts.targetId);
    return withRetry(
      async () => {
        const token = await this.tokenManager.getAccessToken(
          opts.creds.appId,
          opts.creds.clientSecret,
        );
        return this.client.request<UploadMediaResponse>(
          token,
          "POST",
          path,
          { upload_id: uploadId },
          { uploadRequest: true },
        );
      },
      COMPLETE_UPLOAD_RETRY_POLICY,
      undefined,
      this.logger,
    );
  }
}

// ============ Legacy functional facade ============

/**
 * @deprecated The chunked uploader is always implemented.
 *
 * Legacy feature flag. The chunked uploader is fully implemented, so this
 * returns `true`. Retained so that older call sites can be converted
 * progressively.
 */
export function isChunkedUploadImplemented(): boolean {
  return true;
}

// ============ Source resolution ============

/**
 * Normalized chunked-upload input: everything the uploader needs to read
 * the bytes plus the metadata required by `upload_prepare`.
 */
type ChunkedInput =
  | { kind: "localPath"; path: string; size: number; fileName: string }
  | { kind: "buffer"; buffer: Buffer; size: number; fileName: string };

function resolveSource(source: MediaSource, fileNameOverride?: string): ChunkedInput {
  if (source.kind === "localPath") {
    const inferredName = source.path.split(/[/\\]/).pop() || "file";
    return {
      kind: "localPath",
      path: source.path,
      size: source.size,
      fileName: fileNameOverride ?? inferredName,
    };
  }
  if (source.kind === "buffer") {
    return {
      kind: "buffer",
      buffer: source.buffer,
      size: source.buffer.length,
      fileName: fileNameOverride ?? source.fileName ?? "file",
    };
  }
  throw new Error(
    `ChunkedMediaApi: unsupported source kind '${source.kind}'. ` +
      "Chunked upload only supports 'localPath' and 'buffer'; route 'url'/'base64' through the one-shot uploader.",
  );
}

async function readPart(input: ChunkedInput, offset: number, length: number): Promise<Buffer> {
  if (input.kind === "buffer") {
    return input.buffer.subarray(offset, offset + length);
  }
  const handle = await fs.promises.open(input.path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return bytesRead < length ? buf.subarray(0, bytesRead) : buf;
  } finally {
    await handle.close();
  }
}

// ============ Hash computation ============

/**
 * Stream the source once to compute md5 + sha1 + md5_10m.
 *
 * For buffer inputs the three hashes are computed in a single pass over
 * the existing memory. For localPath inputs a ReadStream drives the
 * hashers so memory use stays constant.
 */
async function computeHashes(input: ChunkedInput): Promise<UploadPrepareHashes> {
  if (input.kind === "buffer") {
    const md5 = crypto.createHash("md5").update(input.buffer).digest("hex");
    const sha1 = crypto.createHash("sha1").update(input.buffer).digest("hex");
    const md5_10m =
      input.size > MD5_10M_SIZE
        ? crypto.createHash("md5").update(input.buffer.subarray(0, MD5_10M_SIZE)).digest("hex")
        : md5;
    return { md5, sha1, md5_10m };
  }

  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash("md5");
    const sha1 = crypto.createHash("sha1");
    const md5_10m = crypto.createHash("md5");
    let consumed = 0;
    const needsMd5_10m = input.size > MD5_10M_SIZE;

    const stream = fs.createReadStream(input.path);
    stream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      md5.update(buf);
      sha1.update(buf);
      if (needsMd5_10m) {
        const remaining = MD5_10M_SIZE - consumed;
        if (remaining > 0) {
          md5_10m.update(remaining >= buf.length ? buf : buf.subarray(0, remaining));
        }
      }
      consumed += buf.length;
    });
    stream.on("end", () => {
      const md5Hex = md5.digest("hex");
      const sha1Hex = sha1.digest("hex");
      resolve({
        md5: md5Hex,
        sha1: sha1Hex,
        md5_10m: needsMd5_10m ? md5_10m.digest("hex") : md5Hex,
      });
    });
    stream.on("error", reject);
  });
}

// ============ COS PUT ============

/** Per-part retry budget for the COS PUT call (exponential backoff). */
const PART_UPLOAD_MAX_RETRIES = 2;

async function putToPresignedUrl(
  presignedUrl: string,
  data: Buffer,
  partIndex: number,
  totalParts: number,
  logger: EngineLogger | undefined,
  prefix: string,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PART_UPLOAD_TIMEOUT_MS);

    try {
      // Convert to a standard ArrayBuffer before wrapping in Blob so type
      // definitions (incl. bun-types) accept the argument.
      const ab = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;

      const startTime = Date.now();
      const response = await fetch(presignedUrl, {
        method: "PUT",
        body: new Blob([ab]),
        headers: { "Content-Length": String(data.length) },
        signal: controller.signal,
      });
      const elapsed = Date.now() - startTime;
      const requestId = response.headers.get("x-cos-request-id") ?? "-";
      const etag = response.headers.get("ETag") ?? "-";

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger?.error?.(
          `${prefix} PUT part ${partIndex}/${totalParts}: HTTP ${response.status} ${response.statusText} (${elapsed}ms, requestId=${requestId}) body=${body.slice(0, 160)}`,
        );
        throw new Error(
          `COS PUT failed: ${response.status} ${response.statusText} - ${body.slice(0, 120)}`,
        );
      }

      logger?.debug?.(
        `${prefix} PUT part ${partIndex}/${totalParts} OK (${elapsed}ms ETag=${etag} requestId=${requestId})`,
      );
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === "AbortError") {
        lastError = new Error(
          `Part ${partIndex}/${totalParts} upload timeout after ${PART_UPLOAD_TIMEOUT_MS}ms`,
        );
      }
      if (attempt < PART_UPLOAD_MAX_RETRIES) {
        const delay = 1000 * 2 ** attempt;
        (logger?.warn ?? logger?.error)?.(
          `${prefix} PUT part ${partIndex}/${totalParts} attempt ${attempt + 1} failed (${lastError.message.slice(0, 120)}), retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error(`Part ${partIndex}/${totalParts} upload failed`);
}

// ============ Concurrency ============

/**
 * Batch-mode concurrency limiter. Deliberately simple: dispatch N tasks at
 * a time and wait for the whole batch to settle before the next batch.
 *
 * A pool / queue implementation would recover some throughput when tasks
 * have heavy variance, but part uploads are size-uniform (last part can be
 * short) so the extra complexity is not worth it.
 */
async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  maxConcurrent: number,
): Promise<void> {
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    await Promise.all(batch.map((task) => task()));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
