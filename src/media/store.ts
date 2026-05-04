import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveConfigDir } from "../utils.js";
import { detectMime, extensionForMime } from "./mime.js";
import { isSafeOpenError, readLocalFileSafely, type SafeOpenLikeError } from "./store.runtime.js";

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
  const relative = path.relative(mediaDir, dir);
  if (relative && (relative === ".." || relative.startsWith(`..${path.sep}`))) {
    throw new Error(`${caller}: media subdir escapes media directory: ${JSON.stringify(subdir)}`);
  }
  return dir;
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
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  const sanitized = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  // Collapse multiple underscores, trim leading/trailing, limit length
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

/**
 * Extract original filename from path if it matches the embedded format.
 * Pattern: {original}---{uuid}.{ext} → returns "{original}.{ext}"
 * Falls back to basename if no pattern match, or "file.bin" if empty.
 */
export function extractOriginalFilename(filePath: string): string {
  const basename = path.basename(filePath);
  if (!basename) {
    return "file.bin";
  } // Fallback for empty input

  const ext = path.extname(basename);
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

function isMissingPathError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

async function retryAfterRecreatingDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
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
  const mediaDir = await ensureMediaDir();
  const now = Date.now();
  const recursive = options.recursive ?? false;
  const pruneEmptyDirs = recursive && (options.pruneEmptyDirs ?? false);

  const removeExpiredFilesInDir = async (dir: string): Promise<boolean> => {
    const dirEntries = await fs.readdir(dir).catch(() => null);
    if (!dirEntries) {
      return false;
    }
    for (const entry of dirEntries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.lstat(fullPath).catch(() => null);
      if (!stat || stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        if (recursive) {
          const childIsEmpty = await removeExpiredFilesInDir(fullPath);
          if (childIsEmpty) {
            await fs.rmdir(fullPath).catch(() => {});
          }
        }
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      if (now - stat.mtimeMs > ttlMs) {
        await fs.rm(fullPath, { force: true }).catch(() => {});
      }
    }
    if (!pruneEmptyDirs) {
      return false;
    }
    const remainingEntries = await fs.readdir(dir).catch(() => null);
    return remainingEntries !== null && remainingEntries.length === 0;
  };

  const entries = await fs.readdir(mediaDir).catch(() => []);
  for (const file of entries) {
    const full = path.join(mediaDir, file);
    const stat = await fs.lstat(full).catch(() => null);
    if (!stat || stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      const dirIsEmpty = await removeExpiredFilesInDir(full);
      if (dirIsEmpty) {
        await fs.rmdir(full).catch(() => {});
      }
      continue;
    }
    if (stat.isFile() && now - stat.mtimeMs > ttlMs) {
      await fs.rm(full, { force: true }).catch(() => {});
    }
  }
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
            const redirectUrl = new URL(location, url).href;
            const redirectHeaders =
              new URL(redirectUrl).origin === parsedUrl.origin
                ? headers
                : retainSafeHeadersForCrossOriginRedirect(headers);
            resolve(downloadToFile(redirectUrl, dest, redirectHeaders, maxRedirects - 1, maxBytes));
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

  const base = path.parse(params.originalFilename).name;
  const sanitized = sanitizeFilename(base);
  return sanitized
    ? `${sanitized}---${params.baseId}${params.ext}`
    : `${params.baseId}${params.ext}`;
}

function safeOriginalFilenameExtension(originalFilename?: string): string | undefined {
  if (!originalFilename) {
    return undefined;
  }
  const ext = path.extname(originalFilename).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
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
  dir: string;
  id: string;
  buffer: Buffer;
}): Promise<string> {
  const dest = path.join(params.dir, params.id);
  await retryAfterRecreatingDir(params.dir, async () => {
    const tempDest = path.join(params.dir, `.${params.id}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(tempDest, params.buffer, { mode: MEDIA_FILE_MODE });
      const handle = await fs.open(tempDest, "r");
      try {
        await syncSavedMediaHandle(handle);
      } finally {
        await handle.close();
      }
      await fs.rename(tempDest, dest);
    } catch (err) {
      await fs.rm(tempDest, { force: true }).catch(() => {});
      throw err;
    }
  });
  return dest;
}

async function syncSavedMediaHandle(handle: fs.FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
      return;
    }
    throw err;
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

function toSaveMediaSourceError(
  err: SafeOpenLikeError,
  maxBytes = MAX_BYTES,
): SaveMediaSourceError {
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
    const tempDest = path.join(dir, `${baseId}.tmp`);
    const { headerMime, sniffBuffer, size } = await retryAfterRecreatingDir(dir, () =>
      downloadToFile(source, tempDest, headers, 5, maxBytes),
    );
    const mime = await detectMime({
      buffer: sniffBuffer,
      headerMime,
      filePath: source,
    });
    const ext = extensionForMime(mime) ?? path.extname(new URL(source).pathname);
    const id = buildSavedMediaId({ baseId, ext });
    const finalDest = path.join(dir, id);
    await fs.rename(tempDest, finalDest);
    return buildSavedMediaResult({ dir, id, size, contentType: mime });
  }
  try {
    const { buffer, stat } = await readLocalFileSafely({ filePath: source, maxBytes });
    const mime = await detectMime({ buffer, filePath: source });
    const ext = extensionForMime(mime) ?? path.extname(source);
    const id = buildSavedMediaId({ baseId, ext });
    await writeSavedMediaBuffer({ dir, id, buffer });
    return buildSavedMediaResult({ dir, id, size: stat.size, contentType: mime });
  } catch (err) {
    if (isSafeOpenError(err)) {
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
): Promise<SavedMedia> {
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`);
  }
  const dir = resolveMediaScopedDir(subdir, "saveMediaBuffer");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const uuid = crypto.randomUUID();
  const headerExt = extensionForMime(normalizeOptionalString(contentType?.split(";")[0]));
  const mime = await detectMime({ buffer, headerMime: contentType });
  const ext =
    headerExt ?? extensionForMime(mime) ?? safeOriginalFilenameExtension(originalFilename) ?? "";
  const id = buildSavedMediaId({ baseId: uuid, ext, originalFilename });
  await writeSavedMediaBuffer({ dir, id, buffer });
  return buildSavedMediaResult({ dir, id, size: buffer.byteLength, contentType: mime });
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
 */
export async function resolveMediaBufferPath(id: string, subdir = "inbound"): Promise<string> {
  // Guard against path traversal and null-byte injection.
  //
  // - Separator checks: reject any ID containing "/" or "\" (covers all
  //   relative traversal sequences such as "../foo" or "..\\foo").
  // - Exact ".." check: reject the bare traversal operator in case a caller
  //   strips separators but keeps the dots.
  // - Null-byte check: reject "\0" which can truncate paths on some platforms
  //   and cause the OS to open a different file than intended.
  //
  // We allow consecutive dots in legitimate filenames (e.g. "report..draft.png"),
  // so we only reject the exact two-character string "..".
  //
  // JSON.stringify is used in the error message so that control characters
  // (including \0) are rendered visibly in logs rather than silently dropped.
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "..") {
    throw new Error(`resolveMediaBufferPath: unsafe media ID: ${JSON.stringify(id)}`);
  }

  const dir = resolveMediaScopedDir(subdir, "resolveMediaBufferPath");
  const resolved = path.join(dir, id);

  // Double-check that path.join didn't escape the intended directory.
  // This should be unreachable after the separator check above, but be
  // explicit about the invariant.
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
    throw new Error(`resolveMediaBufferPath: path escapes media directory: ${JSON.stringify(id)}`);
  }

  // lstat (not stat) so we see symlinks rather than following them.
  const stat = await fs.lstat(resolved);

  if (stat.isSymbolicLink()) {
    throw new Error(
      `resolveMediaBufferPath: refusing to follow symlink for media ID: ${JSON.stringify(id)}`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `resolveMediaBufferPath: media ID does not resolve to a file: ${JSON.stringify(id)}`,
    );
  }

  return resolved;
}

/**
 * Deletes a file previously saved by saveMediaBuffer.
 *
 * This is used by parseMessageWithAttachments to clean up files that were
 * successfully offloaded earlier in the same request when a later attachment
 * fails validation and the entire parse is aborted, preventing orphaned files
 * from accumulating on disk ahead of the periodic TTL sweep.
 *
 * Uses resolveMediaBufferPath to apply the same path-safety guards as the
 * read path (separator checks, symlink rejection, etc.) before unlinking.
 *
 * Errors are intentionally not suppressed — callers that want best-effort
 * cleanup should catch and discard exceptions themselves (e.g. via
 * Promise.allSettled).
 *
 * @param id     The media ID as returned by SavedMedia.id.
 * @param subdir The subdirectory the file was saved into (default "inbound").
 */
export async function deleteMediaBuffer(id: string, subdir: "inbound" = "inbound"): Promise<void> {
  const physicalPath = await resolveMediaBufferPath(id, subdir);
  await fs.unlink(physicalPath);
}
