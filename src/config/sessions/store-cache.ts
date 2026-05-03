import { createExpiringMapCache, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import type { SessionEntry } from "./types.js";

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
};

const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)

const SESSION_STORE_CACHE = createExpiringMapCache<string, SessionStoreCacheEntry>({
  ttlMs: getSessionStoreTtl,
});
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, string>();

export function cloneSessionStoreRecord(
  store: Record<string, SessionEntry>,
  serialized?: string,
): Record<string, SessionEntry> {
  return JSON.parse(serialized ?? JSON.stringify(store)) as Record<string, SessionEntry>;
}

export function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

export function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

export function clearSessionStoreCaches(): void {
  SESSION_STORE_CACHE.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
}

export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
}

export function getSerializedSessionStore(storePath: string): string | undefined {
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath);
}

export function setSerializedSessionStore(storePath: string, serialized?: string): void {
  if (serialized === undefined) {
    SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, serialized);
}

export function dropSessionStoreObjectCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

export function readSessionStoreCache(params: {
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
  clone?: boolean;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  if (params.clone === false) {
    return cached.store;
  }
  return cloneSessionStoreRecord(cached.store, cached.serialized);
}

export function takeMutableSessionStoreCache(params: {
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  SESSION_STORE_CACHE.delete(params.storePath);
  return cached.store;
}

export function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
}): void {
  SESSION_STORE_CACHE.set(params.storePath, {
    store: params.serialized === undefined ? cloneSessionStoreRecord(params.store) : params.store,
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    serialized: params.serialized,
  });
  if (params.serialized !== undefined) {
    SESSION_STORE_SERIALIZED_CACHE.set(params.storePath, params.serialized);
  }
}
