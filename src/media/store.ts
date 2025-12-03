import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request } from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { detectMime, extensionForMime } from "./mime.js";

const MEDIA_DIR = path.join(os.homedir(), ".warelay", "media");
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes

export function getMediaDir() {
  return MEDIA_DIR;
}

export async function ensureMediaDir() {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
}

export async function cleanOldMedia(ttlMs = DEFAULT_TTL_MS) {
  await ensureMediaDir();
  const entries = await fs.readdir(MEDIA_DIR).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries.map(async (file) => {
      const full = path.join(MEDIA_DIR, file);
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
    const req = request(url, { headers }, (res) => {
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
      const out = createWriteStream(dest);
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
          const sniffBuffer = Buffer.concat(
            sniffChunks,
            Math.min(sniffLen, 16384),
          );
          const rawHeader = res.headers["content-type"];
          const headerMime = Array.isArray(rawHeader)
            ? rawHeader[0]
            : rawHeader;
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
  const dir = subdir ? path.join(MEDIA_DIR, subdir) : MEDIA_DIR;
  await fs.mkdir(dir, { recursive: true });
  await cleanOldMedia();
  const baseId = crypto.randomUUID();
  if (looksLikeUrl(source)) {
    const tempDest = path.join(dir, `${baseId}.tmp`);
    const { headerMime, sniffBuffer, size } = await downloadToFile(
      source,
      tempDest,
      headers,
    );
    const mime = detectMime({
      buffer: sniffBuffer,
      headerMime,
      filePath: source,
    });
    const ext =
      extensionForMime(mime) ?? path.extname(new URL(source).pathname);
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
  const mime = detectMime({ buffer, filePath: source });
  const ext = extensionForMime(mime) ?? path.extname(source);
  const id = ext ? `${baseId}${ext}` : baseId;
  const dest = path.join(dir, id);
  await fs.writeFile(dest, buffer);
  return { id, path: dest, size: stat.size, contentType: mime };
}

export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir = "inbound",
): Promise<SavedMedia> {
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error("Media exceeds 5MB limit");
  }
  const dir = path.join(MEDIA_DIR, subdir);
  await fs.mkdir(dir, { recursive: true });
  const baseId = crypto.randomUUID();
  const mime = detectMime({ buffer, headerMime: contentType });
  const ext = extensionForMime(mime);
  const id = ext ? `${baseId}${ext}` : baseId;
  const dest = path.join(dir, id);
  await fs.writeFile(dest, buffer);
  return { id, path: dest, size: buffer.byteLength, contentType: mime };
}
