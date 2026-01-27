import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { resolveConfigDir } from "../utils.js";
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { detectMime, extensionForMime } from "./mime.js";

const resolveMediaDir = () => path.join(resolveConfigDir(), "media");
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5MB default
const MAX_BYTES = MEDIA_MAX_BYTES;
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Sanitize a filename for cross-platform safety.
 * Removes chars unsafe on Windows/SharePoint/all platforms.
 * Keeps: alphanumeric, dots, hyphens, underscores, Unicode letters/numbers.
 */
function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
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
  if (!basename) return "file.bin"; // Fallback for empty input

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

export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS) {
  const mediaDir = await ensureMediaDir();
  const entries = await fs.readdir(mediaDir).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries.map(async (file) => {
      const full = path.join(mediaDir, file);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) return;
      if (now - stat.mtimeMs > ttlMs) {
        await fs.rm(full).catch(() => {});
      }
    }),
  );
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
    const requestImpl = parsedUrl.protocol === "https:" ? httpsRequest : httpRequest;
    resolvePinnedHostname(parsedUrl.hostname)
      .then((pinned) => {
        const req = requestImpl(parsedUrl, { headers, lookup: pinned.lookup }, (res) => {
          // Follow redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location;
            if (!location || maxRedirects <= 0) {
              reject(new Error(`Redirect loop or missing Location header`));
              return;
            }
            const redirectUrl = new URL(location, url).href;
            resolve(downloadToFile(redirectUrl, dest, headers, maxRedirects - 1));
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading media`));
            return;
          }
          let total = 0;
          const sniffChunks: Buffer[] = [];
          let sniffLen = 0;
          const out = createWriteStream(dest, { mode: 0o600 });
          res.on("data", (chunk) => {
            total += chunk.length;
            if (sniffLen < 16384) {
              sniffChunks.push(chunk);
              sniffLen += chunk.length;
            }
            if (total > MAX_BYTES) {
              req.destroy(new Error("Media exceeds 5MB limit"));
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
            .catch(reject);
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

export async function saveMediaSource(
  source: string,
  headers?: Record<string, string>,
  subdir = "",
): Promise<SavedMedia> {
  const baseDir = resolveMediaDir();
  const dir = subdir ? path.join(baseDir, subdir) : baseDir;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await cleanOldMedia();
  const baseId = crypto.randomUUID();
  if (looksLikeUrl(source)) {
    const tempDest = path.join(dir, `${baseId}.tmp`);
    const { headerMime, sniffBuffer, size } = await downloadToFile(source, tempDest, headers);
    const mime = await detectMime({
      buffer: sniffBuffer,
      headerMime,
      filePath: source,
    });
    const ext = extensionForMime(mime) ?? path.extname(new URL(source).pathname);
    const id = ext ? `${baseId}${ext}` : baseId;
    const finalDest = path.join(dir, id);
    await fs.rename(tempDest, finalDest);
    return { id, path: finalDest, size, contentType: mime };
  }
  // local path
  const stat = await fs.stat(source);
  if (!stat.isFile()) {
    throw new Error("Media path is not a file");
  }
  if (stat.size > MAX_BYTES) {
    throw new Error("Media exceeds 5MB limit");
  }
  const buffer = await fs.readFile(source);
  const mime = await detectMime({ buffer, filePath: source });
  const ext = extensionForMime(mime) ?? path.extname(source);
  const id = ext ? `${baseId}${ext}` : baseId;
  const dest = path.join(dir, id);
  await fs.writeFile(dest, buffer, { mode: 0o600 });
  return { id, path: dest, size: stat.size, contentType: mime };
}

export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir = "inbound",
  maxBytes = MAX_BYTES,
  originalFilename?: string,
): Promise<SavedMedia> {
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Media exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)}MB limit`);
  }
  const dir = path.join(resolveMediaDir(), subdir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const uuid = crypto.randomUUID();
  const headerExt = extensionForMime(contentType?.split(";")[0]?.trim() ?? undefined);
  const mime = await detectMime({ buffer, headerMime: contentType });
  const ext = headerExt ?? extensionForMime(mime) ?? "";

  let id: string;
  if (originalFilename) {
    // Embed original name: {sanitized}---{uuid}.ext
    const base = path.parse(originalFilename).name;
    const sanitized = sanitizeFilename(base);
    id = sanitized ? `${sanitized}---${uuid}${ext}` : `${uuid}${ext}`;
  } else {
    // Legacy: just UUID
    id = ext ? `${uuid}${ext}` : uuid;
  }

  const dest = path.join(dir, id);
  await fs.writeFile(dest, buffer, { mode: 0o600 });
  return { id, path: dest, size: buffer.byteLength, contentType: mime };
}
