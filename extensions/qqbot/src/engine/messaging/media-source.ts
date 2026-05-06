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
 * - `localPath` — on-disk file; kept as a path plus an optional verified
 *   descriptor so uploaders can avoid reopening a path after validation.
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

import type { FileHandle } from "node:fs/promises";
import { FsSafeError, openLocalFileSafely } from "openclaw/plugin-sdk/security-runtime";
import { MAX_UPLOAD_SIZE, formatFileSize, getMimeType } from "../utils/file-utils.js";

// ============ Types ============

/**
 * Fully normalized media source. Downstream uploaders switch on `kind`.
 *
 * - `url`: remote URL — upload via `file_data=null; url=...`.
 * - `base64`: already-encoded base64 — upload via `file_data=...`.
 * - `localPath`: on-disk file — uploaders should prefer `opened` when present
 *   and only reopen `path` for direct, already-normalized test/helper calls.
 * - `buffer`: raw bytes in memory — same as above minus disk I/O.
 */
export type MediaSource =
  | { kind: "url"; url: string }
  | { kind: "base64"; data: string; mime?: string }
  | { kind: "localPath"; path: string; size: number; mime?: string; opened?: OpenedLocalFile }
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
function tryParseDataUrl(value: string): { mime: string; data: string } | null {
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
  handle: FileHandle;
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
  const opened = await openLocalFileSafely({ filePath }).catch((err: unknown) => {
    if (err instanceof FsSafeError && err.code === "not-file") {
      throw new Error("Path is not a regular file", { cause: err });
    }
    throw err;
  });
  try {
    if (opened.stat.size > maxSize) {
      throw new Error(
        `File is too large (${formatFileSize(opened.stat.size)}); QQ Bot API limit is ${formatFileSize(maxSize)}`,
      );
    }
    return {
      handle: opened.handle,
      size: opened.stat.size,
      close: () => opened.handle.close(),
    };
  } catch (err) {
    // Close the handle on any validation failure to avoid fd leaks.
    await opened.handle.close().catch(() => undefined);
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
 * - `localPath` branches open the file with {@link openLocalFile} and carry
 *   that descriptor to the uploader, so later reads use the exact file that
 *   passed regular-file / O_NOFOLLOW / size validation.
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
    return {
      kind: "localPath",
      path: raw.localPath,
      size: opened.size,
      mime: getMimeType(raw.localPath),
      opened,
    };
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
