// Media store persists loaded media files and metadata for later references.
import "../infra/fs-safe-defaults.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { request as httpRequest } from "node:http";
import path from "node:path";
import {
  basenameFromAnyPath,
  extnameFromAnyPath,
  nameFromAnyPath,
} from "@openclaw/media-core/file-name";
import { detectMime, extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { fileStore } from "../infra/file-store.js";
import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import { isPathInside } from "../infra/fs-safe.js";
import type { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { retryAsync } from "../infra/retry.js";
import { writeSiblingTempFile } from "../infra/sibling-temp-file.js";
import { resolveConfigDir } from "../utils.js";
import { downloadMediaToFile, setMediaStoreDownloadDepsForTest } from "./store.download.js";
import { isFsSafeError, readLocalFileSafely, type FsSafeLikeError } from "./store.runtime.js";
import { formatMediaLimitMb, MEDIA_FILE_MODE } from "./store.shared.js";

const resolveMediaDir = () => path.join(resolveConfigDir(), "media");
/** Default per-file media-store byte cap used by inbound staging and plugin SDK callers. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const MAX_BYTES = MEDIA_MAX_BYTES;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
type RequestImpl = typeof httpRequest;
type ResolvePinnedHostnameImpl = typeof resolvePinnedHostname;
type CleanOldMediaOptions = {
  recursive?: boolean;
  pruneEmptyDirs?: boolean;
};

/** Overrides network dependencies for media-store tests. */
function setMediaStoreNetworkDepsForTest(deps?: {
  httpRequest?: RequestImpl;
  httpsRequest?: RequestImpl;
  resolvePinnedHostname?: ResolvePinnedHostnameImpl;
}): void {
  setMediaStoreDownloadDepsForTest(deps);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.mediaStoreTestApi")] = {
    setMediaStoreNetworkDepsForTest,
  };
}

function resolveMediaSubdir(subdir: string, caller: string): string {
  if (typeof subdir !== "string") {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  if (!subdir || subdir === ".") {
    return "";
  }
  if (
    subdir.includes("\0") ||
    path.isAbsolute(subdir) ||
    path.posix.isAbsolute(subdir) ||
    path.win32.isAbsolute(subdir)
  ) {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  const segments = subdir.split(/[\\/]+/u);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${caller}: unsafe media subdir: ${JSON.stringify(subdir)}`);
  }
  return path.join(...segments);
}

function resolveMediaScopedDir(subdir: string, caller: string): string {
  const mediaDir = resolveMediaDir();
  const safeSubdir = resolveMediaSubdir(subdir, caller);
  const dir = safeSubdir ? path.join(mediaDir, safeSubdir) : mediaDir;
  if (!isPathInside(mediaDir, dir)) {
    throw new Error(`${caller}: media subdir escapes media directory: ${JSON.stringify(subdir)}`);
  }
  return dir;
}

function resolveMediaRelativePath(id: string, subdir: string, caller: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "..") {
    throw new Error(`${caller}: unsafe media ID: ${JSON.stringify(id)}`);
  }
  const safeSubdir = resolveMediaSubdir(subdir, caller);
  return safeSubdir ? path.join(safeSubdir, id) : id;
}

function openMediaStore(maxBytes = MAX_BYTES) {
  return fileStore({
    rootDir: resolveMediaDir(),
    dirMode: 0o700,
    maxBytes,
    mode: MEDIA_FILE_MODE,
  });
}

/**
 * Sanitize a filename for cross-platform safety.
 * Removes chars unsafe on Windows/SharePoint/all platforms.
 * Keeps: alphanumeric, dots, hyphens, underscores, Unicode letters/numbers.
 */
function sanitizeFilename(name: string): string {
  const base = sanitizeUntrustedFileName(name, "");
  if (!base) {
    return "";
  }
  const sanitized = base.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  // Collapse multiple underscores, trim leading/trailing, limit length
  return truncateUtf16Safe(sanitized.replace(/_+/g, "_").replace(/^_|_$/g, ""), 60);
}

/** Restores the caller-facing filename from media-store paths with embedded UUID suffixes. */
export function extractOriginalFilename(filePath: string): string {
  const basename = basenameFromAnyPath(filePath);
  if (!basename) {
    return "file.bin";
  }

  const ext = extnameFromAnyPath(basename);
  const nameWithoutExt = path.basename(basename, ext);

  const match = nameWithoutExt.match(
    /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  if (match?.[1]) {
    return `${match[1]}${ext}`;
  }

  return basename;
}

/** Returns the configured absolute media-store root without creating it. */
export function getMediaDir() {
  return resolveMediaDir();
}

/** Creates the configured media-store root with private directory permissions. */
export async function ensureMediaDir() {
  const mediaDir = resolveMediaDir();
  await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
  return mediaDir;
}

function findErrorWithCode(err: unknown, code: string): NodeJS.ErrnoException | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  if ("code" in err && err.code === code) {
    return err as NodeJS.ErrnoException;
  }
  return findErrorWithCode(err.cause, code);
}

function isMissingPathError(err: unknown): boolean {
  return findErrorWithCode(err, "ENOENT") !== undefined;
}

async function retryAfterRecreatingDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  return await retryAsync(
    async () => {
      try {
        return await run();
      } catch (err) {
        throw findErrorWithCode(err, "ENOSPC") ?? err;
      }
    },
    {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 0,
      shouldRetry: isMissingPathError,
      onRetry: async () => {
        // Cleanup can prune the directory between mkdir and file open. Recreate
        // it once; further failures remain terminal instead of looping.
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      },
    },
  );
}

// Maps the cleanup mode onto the prune sweep depth. The fs-safe prune walker keys descent off
// maxDepth whenever it is set and only falls back to the recursive flag when maxDepth is undefined,
// so recursive:false must resolve to depth 0 (root only). Without this, recursive:false collapses
// to the same one-level sweep as the unset default and would still descend into — and delete —
// retained media subdirectories (e.g. media/inbound/<id>).
function resolveCleanupMaxDepth(recursive: boolean | undefined): number | undefined {
  if (recursive === true) {
    return undefined; // full-tree sweep (configured maintenance timer)
  }
  if (recursive === false) {
    return 0; // root-only sweep; never descend into retained subdirectories
  }
  return 1; // default: prune the media root and its immediate first-level subdirectories
}

/** Prunes expired media files, optionally recursing into scoped media subdirectories. */
export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS, options: CleanOldMediaOptions = {}) {
  await openMediaStore().pruneExpired({
    maxDepth: resolveCleanupMaxDepth(options.recursive),
    ttlMs,
    recursive: options.recursive ?? true,
    pruneEmptyDirs: options.pruneEmptyDirs,
  });
  // Trust metadata must not outlive the staged file that it authorizes.
  const { pruneStaleTrustedGeneratedHtmlMarkers } = await import("./web-media.js");
  await pruneStaleTrustedGeneratedHtmlMarkers();
}

function looksLikeUrl(src: string) {
  return hasHttpUrlPrefix(src);
}

/** Media-store file metadata returned after bytes are persisted under a safe media ID. */
export type SavedMedia = {
  id: string;
  path: string;
  size: number;
  contentType?: string;
};

function buildSavedMediaId(params: {
  baseId: string;
  ext: string;
  originalFilename?: string;
}): string {
  if (!params.originalFilename) {
    return params.ext ? `${params.baseId}${params.ext}` : params.baseId;
  }

  const base = nameFromAnyPath(params.originalFilename);
  const sanitized = sanitizeFilename(base);
  return sanitized
    ? `${sanitized}---${params.baseId}${params.ext}`
    : `${params.baseId}${params.ext}`;
}

function safeOriginalFilenameExtension(originalFilename?: string): string | undefined {
  if (!originalFilename) {
    return undefined;
  }
  const ext = extnameFromAnyPath(originalFilename).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
}

function extensionForAuthoritativeHeaderMime(contentType?: string): string | undefined {
  const mime = normalizeMimeType(contentType);
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    return undefined;
  }
  if (mime === "application/zip") {
    return undefined;
  }
  return extensionForMime(mime);
}

function isGenericContainerMime(mime?: string): boolean {
  return mime === "application/zip" || mime === "application/octet-stream";
}

function isImageHeaderMime(contentType?: string): boolean {
  return normalizeMimeType(contentType)?.startsWith("image/") === true;
}

function resolveSavedMediaExtension(params: {
  detectedMime?: string;
  headerExt?: string;
  contentType?: string;
  originalFilename?: string;
}): string {
  const trustedHeaderExt =
    params.headerExt &&
    isGenericContainerMime(params.detectedMime) &&
    isImageHeaderMime(params.contentType)
      ? undefined
      : params.headerExt;
  return (
    trustedHeaderExt ??
    extensionForMime(params.detectedMime) ??
    safeOriginalFilenameExtension(params.originalFilename) ??
    ""
  );
}

function buildSavedMediaResult(params: {
  dir: string;
  id: string;
  size: number;
  contentType?: string;
}): SavedMedia {
  return {
    id: params.id,
    path: path.join(params.dir, params.id),
    size: params.size,
    contentType: params.contentType,
  };
}

type SavedMediaTempWriteResult = Omit<SavedMedia, "path">;

async function saveMediaSiblingTempFile(params: {
  dir: string;
  tempPrefix: string;
  writeTemp: (tempPath: string) => Promise<SavedMediaTempWriteResult>;
}): Promise<SavedMedia> {
  const { result } = await retryAfterRecreatingDir(params.dir, () =>
    writeSiblingTempFile<SavedMediaTempWriteResult>({
      dir: params.dir,
      mode: MEDIA_FILE_MODE,
      tempPrefix: params.tempPrefix,
      writeTemp: params.writeTemp,
      resolveFinalPath: (resultLocal) => path.join(params.dir, resultLocal.id),
    }),
  );
  return buildSavedMediaResult({ dir: params.dir, ...result });
}

async function writeSavedMediaBuffer(params: {
  subdir: string;
  id: string;
  buffer: Buffer;
}): Promise<string> {
  const dir = resolveMediaScopedDir(params.subdir, "writeSavedMediaBuffer");
  const relativePath = resolveMediaRelativePath(params.id, params.subdir, "writeSavedMediaBuffer");
  return await retryAfterRecreatingDir(
    dir,
    async () =>
      await openMediaStore(params.buffer.byteLength).write(relativePath, params.buffer, {
        tempPrefix: `.${params.id}`,
      }),
  );
}

async function writeMediaStreamToFile(params: {
  stream: AsyncIterable<unknown>;
  tempPath: string;
  maxBytes: number;
}): Promise<{ sniffBuffer: Buffer; size: number }> {
  const handle = await fs.open(params.tempPath, "wx", MEDIA_FILE_MODE);
  const sniffChunks: Buffer[] = [];
  let sniffLen = 0;
  let total = 0;
  try {
    for await (const chunk of params.stream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof ArrayBuffer
            ? Buffer.from(chunk)
            : ArrayBuffer.isView(chunk)
              ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : undefined;
      if (!buffer) {
        throw new TypeError(`Unsupported media stream chunk: ${typeof chunk}`);
      }
      if (buffer.byteLength === 0) {
        continue;
      }
      total += buffer.byteLength;
      if (total > params.maxBytes) {
        throw new Error(`Media exceeds ${formatMediaLimitMb(params.maxBytes)} limit`);
      }
      if (sniffLen < 16384) {
        const remaining = 16384 - sniffLen;
        sniffChunks.push(buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer);
        sniffLen += Math.min(buffer.byteLength, remaining);
      }
      await handle.write(buffer);
    }
    return {
      sniffBuffer: Buffer.concat(sniffChunks, sniffLen),
      size: total,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Stable error categories for unsafe or failed source-file ingestion. */
type SaveMediaSourceErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-file"
  | "path-mismatch"
  | "too-large";

/** Error raised when saveMediaSource cannot safely read or persist a source path. */
class SaveMediaSourceError extends Error {
  code: SaveMediaSourceErrorCode;

  constructor(code: SaveMediaSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SaveMediaSourceError";
  }
}

function toSaveMediaSourceError(err: FsSafeLikeError, maxBytes = MAX_BYTES): SaveMediaSourceError {
  switch (err.code) {
    case "symlink":
      return new SaveMediaSourceError("invalid-path", "Media path must not be a symlink", {
        cause: err,
      });
    case "not-file":
      return new SaveMediaSourceError("not-file", "Media path is not a file", { cause: err });
    case "path-mismatch":
      return new SaveMediaSourceError("path-mismatch", "Media path changed during read", {
        cause: err,
      });
    case "too-large":
      return new SaveMediaSourceError(
        "too-large",
        `Media exceeds ${formatMediaLimitMb(maxBytes)} limit`,
        { cause: err },
      );
    case "not-found":
      return new SaveMediaSourceError("not-found", "Media path does not exist", { cause: err });
    case "outside-workspace":
      return new SaveMediaSourceError("invalid-path", "Media path is outside workspace root", {
        cause: err,
      });
    default:
      return new SaveMediaSourceError("invalid-path", "Media path is not safe to read", {
        cause: err,
      });
  }
}

/** Saves a local path or HTTP(S) source into the media store after MIME/size validation. */
export async function saveMediaSource(
  source: string,
  headers?: Record<string, string>,
  subdir = "",
  maxBytes = MAX_BYTES,
): Promise<SavedMedia> {
  const dir = resolveMediaScopedDir(subdir, "saveMediaSource");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const baseId = crypto.randomUUID();
  if (looksLikeUrl(source)) {
    return await saveMediaSiblingTempFile({
      dir,
      tempPrefix: `.${baseId}`,
      writeTemp: async (tempPath) => {
        const { headerMime, sniffBuffer, size } = await downloadMediaToFile({
          url: source,
          dest: tempPath,
          headers,
          maxBytes,
        });
        const mime = await detectMime({
          buffer: sniffBuffer,
          headerMime,
          filePath: source,
        });
        const ext = extensionForMime(mime) ?? path.extname(new URL(source).pathname);
        const id = buildSavedMediaId({ baseId, ext });
        return { id, size, contentType: mime };
      },
    });
  }
  try {
    const { buffer, stat } = await readLocalFileSafely({ filePath: source, maxBytes });
    const mime = await detectMime({ buffer, filePath: source });
    const ext = extensionForMime(mime) ?? path.extname(source);
    const id = buildSavedMediaId({ baseId, ext });
    await writeSavedMediaBuffer({ subdir, id, buffer });
    return buildSavedMediaResult({ dir, id, size: stat.size, contentType: mime });
  } catch (err) {
    if (isFsSafeError(err)) {
      throw toSaveMediaSourceError(err, maxBytes);
    }
    throw err;
  }
}

/** Saves an in-memory media buffer under a UUID-backed media ID. */
export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
  originalFilename?: string,
  detectionFilePathHint?: string,
): Promise<SavedMedia> {
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`);
  }
  const dir = resolveMediaScopedDir(subdir, "saveMediaBuffer");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const uuid = crypto.randomUUID();
  const headerExt = extensionForAuthoritativeHeaderMime(contentType);
  const mime = await detectMime({
    buffer,
    headerMime: contentType,
    filePath: originalFilename ?? detectionFilePathHint,
  });
  const ext = resolveSavedMediaExtension({
    detectedMime: mime,
    headerExt,
    contentType,
    originalFilename,
  });
  const id = buildSavedMediaId({ baseId: uuid, ext, originalFilename });
  await writeSavedMediaBuffer({ subdir, id, buffer });
  return buildSavedMediaResult({ dir, id, size: buffer.byteLength, contentType: mime });
}

/** Streams media into a sibling temp file before atomically publishing the final media ID. */
export async function saveMediaStream(
  stream: AsyncIterable<unknown>,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
  originalFilename?: string,
  detectionFilePathHint?: string,
): Promise<SavedMedia> {
  const dir = resolveMediaScopedDir(subdir, "saveMediaStream");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const baseId = crypto.randomUUID();
  const headerExt = extensionForAuthoritativeHeaderMime(contentType);
  return await saveMediaSiblingTempFile({
    dir,
    tempPrefix: `.${baseId}`,
    writeTemp: async (tempPath) => {
      const { sniffBuffer, size } = await writeMediaStreamToFile({
        stream,
        tempPath,
        maxBytes,
      });
      const mime = await detectMime({
        buffer: sniffBuffer,
        headerMime: contentType,
        filePath: originalFilename ?? detectionFilePathHint,
      });
      const ext = resolveSavedMediaExtension({
        detectedMime: mime,
        headerExt,
        contentType,
        originalFilename,
      });
      const id = buildSavedMediaId({ baseId, ext, originalFilename });
      return { id, size, contentType: mime };
    },
  });
}

/**
 * Resolves a media ID saved by saveMediaBuffer to its absolute physical path.
 *
 * This is the read-side counterpart to saveMediaBuffer and is used by the
 * agent runner to hydrate opaque `media://inbound/<id>` URIs written by the
 * Gateway's claim-check offload path.
 *
 * Security:
 * - Rejects IDs and subdirs containing path traversal, absolute paths, empty
 *   segments, or null bytes to prevent path injection outside the media root.
 * - Verifies the resolved path is a regular file (not a symlink or directory)
 *   before returning it, matching the write-side MEDIA_FILE_MODE policy.
 *
 * @param id      The media ID as returned by SavedMedia.id (may include
 *                extension and original-filename prefix,
 *                e.g. "photo---<uuid>.png" or "图片---<uuid>.png").
 * @param subdir  The subdirectory the file was saved into (default "inbound").
 * @returns       Absolute path to the file on disk.
 * @throws        If the ID is unsafe, the file does not exist, or is not a
 *                regular file.
 *
 * Prefer readMediaBuffer when the caller needs the bytes; this path-returning
 * helper is for channel surfaces that need a stable local attachment path.
 */
export async function resolveMediaBufferPath(id: string, subdir = "inbound"): Promise<string> {
  const relativePath = resolveMediaRelativePath(id, subdir, "resolveMediaBufferPath");
  const opened = await openMediaStore()
    .open(relativePath)
    .catch(() => null);
  if (!opened?.stat.isFile()) {
    throw new Error(
      `resolveMediaBufferPath: media ID does not resolve to a file: ${JSON.stringify(id)}`,
    );
  }
  try {
    return opened.realPath;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Read result for callers that need media bytes plus the resolved file path. */
type ReadMediaBufferResult = {
  id: string;
  path: string;
  buffer: Buffer;
  size: number;
};

/** Reads a stored media ID with the same path guards and byte limit used by writers. */
export async function readMediaBuffer(
  id: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
): Promise<ReadMediaBufferResult> {
  const relativePath = resolveMediaRelativePath(id, subdir, "readMediaBuffer");
  const opened = await openMediaStore(maxBytes)
    .open(relativePath)
    .catch(() => null);
  if (!opened?.stat.isFile()) {
    throw new Error(`readMediaBuffer: media ID does not resolve to a file: ${JSON.stringify(id)}`);
  }
  try {
    if (opened.stat.size > maxBytes) {
      throw new Error(
        `readMediaBuffer: media ID ${JSON.stringify(id)} is ${opened.stat.size} bytes; maximum is ${maxBytes} bytes`,
      );
    }
    const buffer = await opened.handle.readFile();
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        `readMediaBuffer: media ID ${JSON.stringify(id)} read ${buffer.byteLength} bytes; maximum is ${maxBytes} bytes`,
      );
    }
    return { id, path: opened.realPath, buffer, size: buffer.byteLength };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * Deletes a file previously saved by saveMediaBuffer.
 *
 * This is used by parseMessageWithAttachments to clean up files that were
 * successfully offloaded earlier in the same request when a later attachment
 * fails validation and the entire parse is aborted, preventing orphaned files
 * from accumulating on disk ahead of the periodic TTL sweep.
 *
 * Uses a media-root handle to apply the same path-safety guards as the read
 * path while removing the file under the pinned media root.
 *
 * Errors are intentionally not suppressed — callers that want best-effort
 * cleanup should catch and discard exceptions themselves (e.g. via
 * Promise.allSettled).
 *
 * @param id     The media ID as returned by SavedMedia.id.
 * @param subdir The subdirectory the file was saved into (default "inbound").
 */
export async function deleteMediaBuffer(id: string, subdir = "inbound"): Promise<void> {
  const relativePath = resolveMediaRelativePath(id, subdir, "deleteMediaBuffer");
  await openMediaStore().remove(relativePath);
}
