import "../infra/fs-safe-defaults.js";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileStore } from "../infra/file-store.js";
import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import { isPathInside } from "../infra/fs-safe.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { writeSiblingTempFile } from "../infra/sibling-temp-file.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveConfigDir } from "../utils.js";
import { basenameFromAnyPath, extnameFromAnyPath, nameFromAnyPath } from "./file-name.js";
import { detectMime, extensionForMime } from "./mime.js";
import { isFsSafeError, readLocalFileSafely, type FsSafeLikeError } from "./store.runtime.js";

const resolveMediaDir = () => path.join(resolveConfigDir(), "media");
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5MB default
const MAX_BYTES = MEDIA_MAX_BYTES;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
// Files are intentionally readable by non-owner UIDs so Docker sandbox containers can access
// inbound media. The containing state/media directories remain 0o700, which is the trust boundary.
const MEDIA_FILE_MODE = 0o644;
type CleanOldMediaOptions = {
  recursive?: boolean;
  pruneEmptyDirs?: boolean;
};
type RequestImpl = typeof httpRequest;
type ResolvePinnedHostnameImpl = typeof resolvePinnedHostname;

const defaultHttpRequestImpl: RequestImpl = httpRequest;
const defaultHttpsRequestImpl: RequestImpl = httpsRequest;
const defaultResolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = resolvePinnedHostname;

function formatMediaLimitMb(maxBytes: number): string {
  return `${(maxBytes / (1024 * 1024)).toFixed(0)}MB`;
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

let httpRequestImpl: RequestImpl = defaultHttpRequestImpl;
let httpsRequestImpl: RequestImpl = defaultHttpsRequestImpl;
let resolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = defaultResolvePinnedHostnameImpl;

export function setMediaStoreNetworkDepsForTest(deps?: {
  httpRequest?: RequestImpl;
  httpsRequest?: RequestImpl;
  resolvePinnedHostname?: ResolvePinnedHostnameImpl;
}): void {
  httpRequestImpl = deps?.httpRequest ?? defaultHttpRequestImpl;
  httpsRequestImpl = deps?.httpsRequest ?? defaultHttpsRequestImpl;
  resolvePinnedHostnameImpl = deps?.resolvePinnedHostname ?? defaultResolvePinnedHostnameImpl;
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
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

/**
 * Extract original filename from path if it matches the embedded format.
 * Pattern: {original}---{uuid}.{ext} → returns "{original}.{ext}"
 * Falls back to basename if no pattern match, or "file.bin" if empty.
 */
export function extractOriginalFilename(filePath: string): string {
  const basename = basenameFromAnyPath(filePath);
  if (!basename) {
    return "file.bin";
  } // Fallback for empty input

  const ext = extnameFromAnyPath(basename);
  const nameWithoutExt = path.basename(basename, ext);

  // Check for ---{uuid} pattern (36 chars: 8-4-4-4-12 with hyphens)
  const match = nameWithoutExt.match(
    /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  if (match?.[1]) {
    return `${match[1]}${ext}`;
  }

  return basename; // Fallback: use as-is
}

export function getMediaDir() {
  return resolveMediaDir();
}

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
  try {
    return await run();
  } catch (err) {
    const noSpaceError = findErrorWithCode(err, "ENOSPC");
    if (noSpaceError) {
      throw noSpaceError;
    }
    if (!isMissingPathError(err)) {
      throw err;
    }
    // Recursive cleanup can prune an empty directory between mkdir and the later
    // file open/write. Recreate once and retry the media write path.
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return await run();
  }
}

export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS, options: CleanOldMediaOptions = {}) {
  await openMediaStore().pruneExpired({
    maxDepth: options.recursive ? undefined : 1,
    ttlMs,
    recursive: options.recursive ?? true,
    pruneEmptyDirs: options.pruneEmptyDirs,
  });
}

function looksLikeUrl(src: string) {
  return /^https?:\/\//i.test(src);
}

/**
 * Download media to disk while capturing the first few KB for mime sniffing.
 */
async function downloadToFile(
  url: string,
  dest: string,
  headers?: Record<string, string>,
  maxRedirects = 5,
  maxBytes = MAX_BYTES,
): Promise<{ headerMime?: string; sniffBuffer: Buffer; size: number }> {
  return await new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error("Invalid URL"));
      return;
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      reject(new Error(`Invalid URL protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`));
      return;
    }
    const requestImpl = parsedUrl.protocol === "https:" ? httpsRequestImpl : httpRequestImpl;
    resolvePinnedHostnameImpl(parsedUrl.hostname)
      .then((pinned) => {
        const req = requestImpl(parsedUrl, { headers, lookup: pinned.lookup }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location;
            if (!location || maxRedirects <= 0) {
              reject(new Error(`Redirect loop or missing Location header`));
              return;
            }
            let redirectUrl: URL;
            try {
              redirectUrl = new URL(location, url);
            } catch {
              reject(new Error("Invalid redirect Location header"));
              return;
            }
            const redirectHeaders =
              redirectUrl.origin === parsedUrl.origin
                ? headers
                : retainSafeHeadersForCrossOriginRedirect(headers);
            resolve(
              downloadToFile(redirectUrl.href, dest, redirectHeaders, maxRedirects - 1, maxBytes),
            );
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading media`));
            return;
          }
          let total = 0;
          const sniffChunks: Buffer[] = [];
          let sniffLen = 0;
          const out = createWriteStream(dest, { mode: MEDIA_FILE_MODE });
          res.on("data", (chunk) => {
            total += chunk.length;
            if (sniffLen < 16384) {
              sniffChunks.push(chunk);
              sniffLen += chunk.length;
            }
            if (total > maxBytes) {
              req.destroy(new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`));
            }
          });
          pipeline(res, out)
            .then(() => {
              const sniffBuffer = Buffer.concat(sniffChunks, Math.min(sniffLen, 16384));
              const rawHeader = res.headers["content-type"];
              const headerMime = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
              resolve({
                headerMime,
                sniffBuffer,
                size: total,
              });
            })
            .catch(async (err) => {
              await fs.rm(dest, { force: true }).catch(() => {});
              reject(err);
            });
        });
        req.on("error", reject);
        req.end();
      })
      .catch(reject);
  });
}

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
  const mime = normalizeOptionalString(contentType?.split(";")[0]);
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    return undefined;
  }
  if (mime === "application/zip") {
    return undefined;
  }
  return extensionForMime(mime);
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

export type SaveMediaSourceErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-file"
  | "path-mismatch"
  | "too-large";

export class SaveMediaSourceError extends Error {
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
    case "invalid-path":
    default:
      return new SaveMediaSourceError("invalid-path", "Media path is not safe to read", {
        cause: err,
      });
  }
}

export async function saveMediaSource(
  source: string,
  headers?: Record<string, string>,
  subdir = "",
  maxBytes = MAX_BYTES,
): Promise<SavedMedia> {
  const dir = resolveMediaScopedDir(subdir, "saveMediaSource");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await cleanOldMedia(DEFAULT_TTL_MS, { recursive: false });
  const baseId = crypto.randomUUID();
  if (looksLikeUrl(source)) {
    const saved = await retryAfterRecreatingDir(dir, () =>
      writeSiblingTempFile({
        dir,
        mode: MEDIA_FILE_MODE,
        tempPrefix: `.${baseId}`,
        writeTemp: async (tempPath) => {
          const { headerMime, sniffBuffer, size } = await downloadToFile(
            source,
            tempPath,
            headers,
            5,
            maxBytes,
          );
          const mime = await detectMime({
            buffer: sniffBuffer,
            headerMime,
            filePath: source,
          });
          const ext = extensionForMime(mime) ?? path.extname(new URL(source).pathname);
          const id = buildSavedMediaId({ baseId, ext });
          return { id, size, contentType: mime };
        },
        resolveFinalPath: (result) => path.join(dir, result.id),
      }),
    );
    return buildSavedMediaResult({
      dir,
      id: saved.result.id,
      size: saved.result.size,
      contentType: saved.result.contentType,
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
  const ext =
    headerExt ?? extensionForMime(mime) ?? safeOriginalFilenameExtension(originalFilename) ?? "";
  const id = buildSavedMediaId({ baseId: uuid, ext, originalFilename });
  await writeSavedMediaBuffer({ subdir, id, buffer });
  return buildSavedMediaResult({ dir, id, size: buffer.byteLength, contentType: mime });
}

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
  const saved = await retryAfterRecreatingDir(dir, () =>
    writeSiblingTempFile<{ id: string; size: number; contentType?: string }>({
      dir,
      mode: MEDIA_FILE_MODE,
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
        const ext =
          headerExt ??
          extensionForMime(mime) ??
          safeOriginalFilenameExtension(originalFilename) ??
          "";
        const id = buildSavedMediaId({ baseId, ext, originalFilename });
        return { id, size, contentType: mime };
      },
      resolveFinalPath: (result) => path.join(dir, result.id),
    }),
  );
  return buildSavedMediaResult({
    dir,
    id: saved.result.id,
    size: saved.result.size,
    contentType: saved.result.contentType,
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

export type ReadMediaBufferResult = {
  id: string;
  path: string;
  buffer: Buffer;
  size: number;
};

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
export async function deleteMediaBuffer(id: string, subdir: "inbound" = "inbound"): Promise<void> {
  const relativePath = resolveMediaRelativePath(id, subdir, "deleteMediaBuffer");
  await openMediaStore().remove(relativePath);
}
