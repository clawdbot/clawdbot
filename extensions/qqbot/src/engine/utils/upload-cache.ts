/**
 * Cache `file_info` values returned by the QQ Bot API so identical uploads can be reused
 * before the server-side TTL expires.
 */

import * as crypto from "node:crypto";
import type { ChatScope } from "../types.js";
import { debugLog } from "./log.js";

interface CacheEntry {
  fileInfo: string;
  fileUuid: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 500;

/** Compute an MD5 hash used as part of the cache key. */
export function computeFileHash(data: string | Buffer): string {
  const content = typeof data === "string" ? data : data;
  return crypto.createHash("md5").update(content).digest("hex");
}

/** Build the in-memory cache key. */
function buildCacheKey(
  contentHash: string,
  scope: string,
  targetId: string,
  fileType: number,
): string {
  return `${contentHash}:${scope}:${targetId}:${fileType}`;
}

/** Look up a cached `file_info` value. */
export function getCachedFileInfo(
  contentHash: string,
  scope: ChatScope,
  targetId: string,
  fileType: number,
): string | null {
  const key = buildCacheKey(contentHash, scope, targetId, fileType);
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  debugLog(`[upload-cache] Cache HIT: key=${key.slice(0, 40)}..., fileUuid=${entry.fileUuid}`);
  return entry.fileInfo;
}

/** Store an upload result in the cache. */
export function setCachedFileInfo(
  contentHash: string,
  scope: ChatScope,
  targetId: string,
  fileType: number,
  fileInfo: string,
  fileUuid: string,
  ttl: number,
): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now >= v.expiresAt) {
        cache.delete(k);
      }
    }
    if (cache.size >= MAX_CACHE_SIZE) {
      const keys = Array.from(cache.keys());
      for (let i = 0; i < keys.length / 2; i++) {
        cache.delete(keys[i]);
      }
    }
  }

  const key = buildCacheKey(contentHash, scope, targetId, fileType);
  const safetyMargin = 60;
  const effectiveTtl = Math.max(ttl - safetyMargin, 10);

  cache.set(key, {
    fileInfo,
    fileUuid,
    expiresAt: Date.now() + effectiveTtl * 1000,
  });

  debugLog(
    `[upload-cache] Cache SET: key=${key.slice(0, 40)}..., ttl=${effectiveTtl}s, uuid=${fileUuid}`,
  );
}
