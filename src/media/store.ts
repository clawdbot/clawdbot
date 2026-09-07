// Media store persists loaded media files and metadata for later references.
import "../infra/fs-safe-defaults.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  basenameFromAnyPath,
  extnameFromAnyPath,
  nameFromAnyPath,
} from "@openclaw/media-core/file-name";
import {
  detectMime,
  extensionForMime,
  getFileExtension,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { fileStore } from "../infra/file-store.js";
import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import { FsSafeError, isPathInside, readLocalFileSafely } from "../infra/fs-safe.js";
import type { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { retryAsync } from "../infra/retry.js";
import { writeSiblingTempFile } from "../infra/sibling-temp-file.js";
import { resolveConfigDir } from "../utils.js";
import { MEDIA_FILE_MODE, SaveMediaSourceError } from "./store.shared.js";

const resolveMediaDir = () => path.join(resolveConfigDir(), "media");
/** Default per-file media-store byte cap used by store and plugin SDK callers. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const PLAYBACK_TRANSCODE_SUBDIR = "playback-transcode";

// The outgoing tree is owned by the SQLite managed-media reaper: originals
// there are referenced by durable chat-history records, and the legacy
// records/*.json files are the pre-SQLite migration barrier. An mtime-only
// sweep would delete both out from under that reaper.
const MANAGED_OUTGOING_SUBDIR = "outgoing";
const OUTBOUND_STAGING_SUBDIR = "outbound";
// Match delivery-queue orphan grace: staged files get a full day to reach
// every direct, streamed, fan-out, or queue-owned delivery path.
const OUTBOUND_STAGING_TTL_MS = 24 * 60 * 60_000;
/** Fixed disk budget for cached playback renditions; oldest outputs are evicted first. */
const PLAYBACK_TRANSCODE_MAX_CACHE_BYTES = 512 * 1024 * 1024;
/** Playback renditions outlive transient media but are still retired after one week. */
const PLAYBACK_TRANSCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = MEDIA_MAX_BYTES;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
let playbackCacheOperationTail = Promise.resolve();
let resolvePinnedHostnameForTest: typeof resolvePinnedHostname | undefined;
type CleanOldMediaOptions = {
  recursive?: boolean;
  pruneEmptyDirs?: boolean;
};

/** Overrides the canonical remote resolver for loopback integration tests. */
function setMediaStoreNetworkDepsForTest(deps?: {
  resolvePinnedHostname?: typeof resolvePinnedHostname;
}): void {
  resolvePinnedHostnameForTest = deps?.resolvePinnedHostname;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.mediaStoreTestApi")] = {
    enforcePlaybackTranscodeCacheLimit,
    PLAYBACK_TRANSCODE_MAX_CACHE_BYTES,
    PLAYBACK_TRANSCODE_TTL_MS,
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
  return path.posix.join(...segments);
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
  return safeSubdir ? path.posix.join(safeSubdir, id) : id;
}

function openMediaStore(maxBytes = MAX_BYTES, rootDir = resolveMediaDir()) {
  return fileStore({
    rootDir,
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
  // Store keys require NFC; source filesystem paths keep their original spelling.
  const base = sanitizeUntrustedFileName(name, "").normalize("NFC");
  if (!base) {
    return "";
  }
  const sanitized = base.replace(/[^\p{L}\p{N}._-]+/gu, "_");
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

function hasRecoverableMissingMediaDirCause(err: unknown): boolean {
  // Recursive mkdir repairs only the ENOENT race where cleanup pruned the directory.
  // Structural ENOTDIR and generic fs-safe absence remain terminal diagnostics.
  return findErrorWithCode(err, "ENOENT") !== undefined;
}

async function retryAfterRecreatingDir<T>(
  dir: string,
  run: () => Promise<T>,
  canRetry: () => boolean = () => true,
): Promise<T> {
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
      shouldRetry: (err) => canRetry() && hasRecoverableMissingMediaDirCause(err),
      onRetry: async () => {
        // Cleanup can prune the directory between mkdir and file open. Recreate
        // it once; further failures remain terminal instead of looping.
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      },
    },
  );
}

async function prunePlaybackTranscodeCacheToSize(): Promise<void> {
  const dir = resolveMediaScopedDir(PLAYBACK_TRANSCODE_SUBDIR, "prunePlaybackTranscodeCacheToSize");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = (
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || entry.name.startsWith(".")) {
          return null;
        }
        const stat = await fs.lstat(path.join(dir, entry.name)).catch(() => null);
        return stat?.isFile() ? { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs } : null;
      }),
    )
  )
    .filter((entry): entry is { name: string; size: number; mtimeMs: number } => Boolean(entry))
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  for (const file of files) {
    if (totalBytes <= PLAYBACK_TRANSCODE_MAX_CACHE_BYTES) {
      break;
    }
    const relativePath = resolveMediaRelativePath(
      file.name,
      PLAYBACK_TRANSCODE_SUBDIR,
      "prunePlaybackTranscodeCacheToSize",
    );
    const removed = await openMediaStore()
      .remove(relativePath)
      .then(() => true)
      .catch(() => false);
    if (removed) {
      totalBytes -= file.size;
    }
  }
}

async function pruneNonPlaybackMedia(ttlMs: number, options: CleanOldMediaOptions): Promise<void> {
  if (options.recursive === false) {
    await openMediaStore().pruneExpired({ ttlMs, recursive: false, maxDepth: 0 });
    return;
  }
  const mediaDir = resolveMediaDir();
  await openMediaStore().pruneExpired({ ttlMs, recursive: false, maxDepth: 0 });
  const entries = await fs.readdir(mediaDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === PLAYBACK_TRANSCODE_SUBDIR ||
      entry.name === MANAGED_OUTGOING_SUBDIR
    ) {
      continue;
    }
    const scopedDir = path.join(mediaDir, entry.name);
    const recursive = options.recursive === true;
    await openMediaStore(MAX_BYTES, scopedDir).pruneExpired({
      ttlMs,
      recursive,
      maxDepth: recursive ? undefined : 0,
      pruneEmptyDirs: options.pruneEmptyDirs,
    });
    if (options.pruneEmptyDirs) {
      await fs.rmdir(scopedDir).catch(() => {});
    }
  }
}

async function queuePlaybackCacheOperation<T>(operation: () => Promise<T>): Promise<T> {
  const run = playbackCacheOperationTail.then(operation);
  playbackCacheOperationTail = run.then(
    () => {},
    () => {},
  );
  return await run;
}

/** Serializes cache publication with quota enforcement and propagates failures to the writer. */
export async function writePlaybackTranscodeCache(params: {
  buffer: Buffer;
  fileName: string;
  maxBytes: number;
  tempPrefix: string;
}): Promise<string> {
  return await queuePlaybackCacheOperation(async () => {
    const relativePath = resolveMediaRelativePath(
      params.fileName,
      PLAYBACK_TRANSCODE_SUBDIR,
      "writePlaybackTranscodeCache",
    );
    const filePath = await openMediaStore(params.maxBytes).write(relativePath, params.buffer, {
      maxBytes: params.maxBytes,
      tempPrefix: params.tempPrefix,
    });
    await prunePlaybackTranscodeCacheToSize();
    return filePath;
  });
}

/** Serializes maintenance quota scans with cache insertions. */
async function enforcePlaybackTranscodeCacheLimit(): Promise<void> {
  await queuePlaybackCacheOperation(prunePlaybackTranscodeCacheToSize);
}

/** Prunes expired playback renditions and reapplies the fixed cache size budget. */
export async function prunePlaybackTranscodeCache(): Promise<void> {
  await queuePlaybackCacheOperation(async () => {
    const cacheDir = resolveMediaScopedDir(
      PLAYBACK_TRANSCODE_SUBDIR,
      "prunePlaybackTranscodeCache",
    );
    await openMediaStore(MAX_BYTES, cacheDir).pruneExpired({
      ttlMs: PLAYBACK_TRANSCODE_TTL_MS,
      recursive: true,
      pruneEmptyDirs: true,
    });
    await prunePlaybackTranscodeCacheToSize();
  });
}

/** Prunes stale delivery staging without touching inbound replay or SQLite-owned outgoing media. */
export async function pruneOutboundMedia(): Promise<void> {
  const outboundDir = resolveMediaScopedDir(OUTBOUND_STAGING_SUBDIR, "pruneOutboundMedia");
  await openMediaStore(MAX_BYTES, outboundDir).pruneExpired({
    ttlMs: OUTBOUND_STAGING_TTL_MS,
    recursive: true,
    pruneEmptyDirs: true,
  });
  const { pruneStaleTrustedGeneratedHtmlMarkers } = await import("./web-media.js");
  await pruneStaleTrustedGeneratedHtmlMarkers();
}

/** Prunes expired non-playback media, optionally recursing into scoped subdirectories. */
export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS, options: CleanOldMediaOptions = {}) {
  await pruneNonPlaybackMedia(ttlMs, options);
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
  const ext = extnameFromAnyPath(originalFilename);
  return /^\.[a-z0-9]{1,16}$/i.test(ext) ? ext : undefined;
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
  detectionFilePathHint?: string;
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
    getFileExtension(params.detectionFilePathHint) ??
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
  const sniffBuffer = Buffer.allocUnsafe(16384);
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
        throw SaveMediaSourceError.tooLarge(params.maxBytes);
      }
      if (sniffLen < sniffBuffer.length) {
        // The next pull may reuse the chunk; retain only the prefix we own.
        sniffLen += buffer.copy(sniffBuffer, sniffLen);
      }
      await handle.writeFile(buffer);
    }
    return {
      sniffBuffer: sniffBuffer.subarray(0, sniffLen),
      size: total,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function toSaveMediaSourceError(err: FsSafeError, maxBytes = MAX_BYTES): SaveMediaSourceError {
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
      return SaveMediaSourceError.tooLarge(maxBytes, { cause: err });
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
  if (looksLikeUrl(source)) {
    const { saveRemoteMediaForStore } = await import("./store.remote.runtime.js");
    return await saveRemoteMediaForStore({
      source,
      headers,
      subdir,
      maxBytes,
      resolvePinnedHostnameForTest,
    });
  }
  const baseId = crypto.randomUUID();
  try {
    const { buffer, stat } = await readLocalFileSafely({ filePath: source, maxBytes });
    const mime = await detectMime({ buffer, filePath: source });
    const ext = extensionForMime(mime) ?? path.extname(source);
    const id = buildSavedMediaId({ baseId, ext });
    await writeSavedMediaBuffer({ subdir, id, buffer });
    return buildSavedMediaResult({ dir, id, size: stat.size, contentType: mime });
  } catch (err) {
    if (err instanceof FsSafeError) {
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
    throw SaveMediaSourceError.tooLarge(maxBytes);
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
    detectionFilePathHint,
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
  // Directory setup may retry before iteration starts. A consumed stream cannot
  // be replayed after a write or publication failure.
  let consumptionStarted = false;
  const mediaStream = (async function* () {
    consumptionStarted = true;
    yield* stream;
  })();
  const { result } = await retryAfterRecreatingDir(
    dir,
    () =>
      writeSiblingTempFile<Omit<SavedMedia, "path">>({
        dir,
        mode: MEDIA_FILE_MODE,
        tempPrefix: `.${baseId}`,
        writeTemp: async (tempPath) => {
          const { sniffBuffer, size } = await writeMediaStreamToFile({
            stream: mediaStream,
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
            detectionFilePathHint,
          });
          const id = buildSavedMediaId({ baseId, ext, originalFilename });
          return { id, size, contentType: mime };
        },
        resolveFinalPath: (resultLocal) => path.join(dir, resultLocal.id),
      }),
    () => !consumptionStarted,
  );
  return buildSavedMediaResult({ dir, ...result });
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
