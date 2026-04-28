/**
 * Unified media-source abstraction for the QQ Bot upload pipeline.
 *
 * All rich-media entry points (sender.ts#sendMedia, outbound.ts#send*,
 * reply-dispatcher.ts#handle*Payload) funnel through {@link normalizeSource}
 * before reaching the low-level {@link MediaApi}.
 *
 * ## Why four branches?
 *
 * - `url` — remote http(s) URL that the QQ server can fetch directly.
 * - `base64` — in-memory base64 string (typically from a `data:` URL).
 * - `localPath` — on-disk file; kept as a path so a future chunked-upload
 *   implementation can stream it via `fs.createReadStream` without the 4/3×
 *   base64 memory overhead.
 * - `buffer` — in-memory raw bytes (e.g. TTS output, downloaded url-fallback).
 *
 * ## Security baseline (localPath branch)
 *
 * `openLocalFile` is the single canonical implementation of "safely open a
 * local file for upload" across the plugin. It merges the previously
 * inconsistent strategies from `reply-dispatcher.ts` (O_NOFOLLOW + size check)
 * and `outbound.ts` (realpath + root containment). Callers are still
 * responsible for *root-whitelist* validation (via
 * `resolveQQBotPayloadLocalFilePath` / `resolveOutboundMediaPath`) before
 * passing the path in; this function enforces *file-level* safety only.
 *
 * Chunked upload is not implemented in this PR, but the contract here already
 * returns `size` metadata so `sendMediaInternal` can route by size without
 * reading the whole file first.
 */

import * as fs from "node:fs";
import { MAX_UPLOAD_SIZE, formatFileSize, getMimeType } from "../utils/file-utils.js";

// ============ Types ============

/**
 * Fully normalized media source. Downstream uploaders switch on `kind`.
 *
 * - `url`: remote URL — upload via `file_data=null; url=...`.
 * - `base64`: already-encoded base64 — upload via `file_data=...`.
 * - `localPath`: on-disk file — one-shot path reads it into a buffer;
 *   chunked path (future) streams it via `fs.createReadStream`.
 * - `buffer`: raw bytes in memory — same as above minus disk I/O.
 */
export type MediaSource =
  | { kind: "url"; url: string }
  | { kind: "base64"; data: string; mime?: string }
  | { kind: "localPath"; path: string; size: number; mime?: string }
  | { kind: "buffer"; buffer: Buffer; fileName?: string; mime?: string };

/**
 * Untyped media source accepted from callers.
 *
 * `url` may be either a remote `http(s)://...` URL or a `data:<mime>;base64,...`
 * data URL — {@link normalizeSource} transparently resolves the latter to a
 * `base64` branch.
 */
export type RawMediaSource =
  | { url: string }
  | { base64: string; mime?: string }
  | { localPath: string }
  | { buffer: Buffer; fileName?: string; mime?: string };

// ============ data: URL ============

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;

/**
 * Parse a `data:<mime>;base64,<payload>` URL.
 *
 * Returns `null` when the string is not a data URL or does not declare
 * base64 encoding. Non-base64 data URLs are intentionally rejected because
 * the QQ upload API ingests raw base64, not arbitrary URL-encoded payloads.
 */
export function tryParseDataUrl(value: string): { mime: string; data: string } | null {
  if (!value.startsWith("data:")) {
    return null;
  }
  const m = value.match(DATA_URL_RE);
  if (!m) {
    return null;
  }
  return { mime: m[1], data: m[2] };
}

// ============ Local file safe open ============

/**
 * Opened handle to a local file, with metadata already validated against
 * QQ upload limits.
 *
 * Callers MUST call {@link OpenedLocalFile.close} (typically in a `finally`).
 */
export interface OpenedLocalFile {
  handle: fs.promises.FileHandle;
  size: number;
  close(): Promise<void>;
}

/**
 * Open a local file for upload with defense-in-depth:
 *
 * 1. `O_NOFOLLOW` refuses to traverse symlinks (prevents post-whitelist
 *    symlink swaps / TOCTOU attacks).
 * 2. `fstat` on the opened descriptor — NOT `fs.stat` on the path —
 *    so the size check applies to the exact byte stream we will read.
 * 3. Rejects non-regular files (sockets / devices / directories).
 * 4. Enforces a caller-specified `maxSize` (default {@link MAX_UPLOAD_SIZE})
 *    at open time, so oversized files fail fast without allocating a
 *    full buffer. Chunked upload callers should pass a larger ceiling
 *    (e.g. `CHUNKED_UPLOAD_MAX_SIZE` from `utils/file-utils.js`).
 *
 * The caller receives the open handle plus validated size and is expected
 * to either {@link OpenedLocalFile.handle.readFile} (one-shot path) or
 * stream via `fs.createReadStream` (chunked path).
 */
export async function openLocalFile(
  filePath: string,
  opts: { maxSize?: number } = {},
): Promise<OpenedLocalFile> {
  const maxSize = opts.maxSize ?? MAX_UPLOAD_SIZE;
  const openFlags =
    fs.constants.O_RDONLY | ("O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0);
  const handle = await fs.promises.open(filePath, openFlags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Path is not a regular file");
    }
    if (stat.size > maxSize) {
      throw new Error(
        `File is too large (${formatFileSize(stat.size)}); QQ Bot API limit is ${formatFileSize(maxSize)}`,
      );
    }
    return {
      handle,
      size: stat.size,
      close: () => handle.close(),
    };
  } catch (err) {
    // Close the handle on any validation failure to avoid fd leaks.
    await handle.close().catch(() => undefined);
    throw err;
  }
}

// ============ Normalization ============

/**
 * Normalize a {@link RawMediaSource} into a {@link MediaSource}.
 *
 * - Strings passed via `{ url }` that start with `data:` are auto-resolved
 *   to a `base64` branch (this is the unified `data:` URL support that was
 *   previously only implemented in `sendImage`).
 * - `localPath` branches open the file with {@link openLocalFile} solely to
 *   validate size / regular-file / O_NOFOLLOW invariants. The handle is
 *   closed immediately — actual reading is deferred to the uploader so
 *   the chunked path can stream without double-reading.
 * - `buffer` branches enforce the same ceiling inline.
 *
 * `maxSize` defaults to {@link MAX_UPLOAD_SIZE} (20MB, one-shot upload limit).
 * Callers that dispatch to the chunked uploader should pass a larger ceiling
 * (e.g. `CHUNKED_UPLOAD_MAX_SIZE`, or a value derived from
 * `getMaxUploadSize(fileType)`).
 *
 * NOTE: Root-whitelist validation (i.e. "this path must live under the
 * allowed QQ Bot media directory") is a caller concern. This function
 * assumes the path has already passed such checks.
 */
export async function normalizeSource(
  raw: RawMediaSource,
  opts: { maxSize?: number } = {},
): Promise<MediaSource> {
  const maxSize = opts.maxSize ?? MAX_UPLOAD_SIZE;

  if ("url" in raw) {
    const parsed = tryParseDataUrl(raw.url);
    if (parsed) {
      return { kind: "base64", data: parsed.data, mime: parsed.mime };
    }
    return { kind: "url", url: raw.url };
  }

  if ("base64" in raw) {
    return { kind: "base64", data: raw.base64, mime: raw.mime };
  }

  if ("localPath" in raw) {
    const opened = await openLocalFile(raw.localPath, { maxSize });
    try {
      return {
        kind: "localPath",
        path: raw.localPath,
        size: opened.size,
        mime: getMimeType(raw.localPath),
      };
    } finally {
      await opened.close();
    }
  }

  // buffer branch
  if (raw.buffer.length > maxSize) {
    throw new Error(
      `Buffer is too large (${formatFileSize(raw.buffer.length)}); QQ Bot API limit is ${formatFileSize(maxSize)}`,
    );
  }
  return {
    kind: "buffer",
    buffer: raw.buffer,
    fileName: raw.fileName,
    mime: raw.mime,
  };
}

// ============ Materialization helpers ============

/**
 * Read a {@link MediaSource} into the `{ url?, fileData?, fileName? }` shape
 * expected by {@link MediaApi.uploadMedia} today (one-shot upload path).
 *
 * Chunked upload (future) should bypass this helper and feed the uploader
 * directly from the `localPath` / `buffer` branch.
 */
export async function materializeForOneShotUpload(
  source: MediaSource,
): Promise<{ url?: string; fileData?: string; fileName?: string }> {
  switch (source.kind) {
    case "url":
      return { url: source.url };
    case "base64":
      return { fileData: source.data };
    case "localPath": {
      const opened = await openLocalFile(source.path);
      try {
        const buf = await opened.handle.readFile();
        return { fileData: buf.toString("base64") };
      } finally {
        await opened.close();
      }
    }
    case "buffer":
      return {
        fileData: source.buffer.toString("base64"),
        fileName: source.fileName,
      };
    default: {
      const _exhaustive: never = source;
      throw new Error(
        `materializeForOneShotUpload: unsupported MediaSource kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}
