import { createExpiringMapCache, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import type { SessionEntry } from "./types.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type SessionStoreSnapshot = DeepReadonly<Record<string, SessionEntry>>;

export type SessionStoreSnapshotEntry = DeepReadonly<SessionEntry>;

export type SessionStoreSnapshotEntries = ReadonlyArray<
  readonly [string, SessionStoreSnapshotEntry]
>;

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
};

type SessionStoreSnapshotCacheEntry = {
  snapshot: SessionStoreSnapshot;
  mtimeMs?: number;
  sizeBytes?: number;
  generation: number;
  createdAt: number;
  entryCount: number;
};

type SerializedSessionStoreCacheEntry = {
  serialized: string;
  sizeBytes: number;
};

const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)
const DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_ENTRIES = 64;
const DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const LARGE_SESSION_STORE_STRING_MIN_CHARS = 512;
const LARGE_SESSION_STORE_STRING_MAX_INTERNED = 256;

const SESSION_STORE_CACHE = createExpiringMapCache<string, SessionStoreCacheEntry>({
  ttlMs: getSessionStoreTtl,
});
const SESSION_STORE_SNAPSHOT_CACHE = createExpiringMapCache<string, SessionStoreSnapshotCacheEntry>(
  {
    ttlMs: getSessionStoreTtl,
  },
);
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, SerializedSessionStoreCacheEntry>();
const SESSION_STORE_STRING_INTERN_POOL = new Map<string, string>();
const SESSION_STORE_STRING_INTERN_STATS = {
  stored: 0,
  reused: 0,
  skippedSmall: 0,
  skippedFull: 0,
};
let sessionStoreSnapshotGeneration = 0;
let sessionStoreSerializedCacheBytes = 0;

function parseNonNegativeInteger(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getSerializedSessionStoreCacheMaxBytes(): number {
  return (
    parseNonNegativeInteger(process.env.OPENCLAW_SESSION_SERIALIZED_CACHE_MAX_BYTES) ??
    DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_BYTES
  );
}

function getSerializedSessionStoreCacheMaxEntries(): number {
  return DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_ENTRIES;
}

function resetSessionStoreStringInternStats(): void {
  SESSION_STORE_STRING_INTERN_STATS.stored = 0;
  SESSION_STORE_STRING_INTERN_STATS.reused = 0;
  SESSION_STORE_STRING_INTERN_STATS.skippedSmall = 0;
  SESSION_STORE_STRING_INTERN_STATS.skippedFull = 0;
}

function internLargeSessionStoreString(value: string): string {
  if (value.length < LARGE_SESSION_STORE_STRING_MIN_CHARS) {
    SESSION_STORE_STRING_INTERN_STATS.skippedSmall += 1;
    return value;
  }
  const interned = SESSION_STORE_STRING_INTERN_POOL.get(value);
  if (interned !== undefined) {
    SESSION_STORE_STRING_INTERN_STATS.reused += 1;
    return interned;
  }
  if (SESSION_STORE_STRING_INTERN_POOL.size >= LARGE_SESSION_STORE_STRING_MAX_INTERNED) {
    SESSION_STORE_STRING_INTERN_STATS.skippedFull += 1;
    return value;
  }
  SESSION_STORE_STRING_INTERN_POOL.set(value, value);
  SESSION_STORE_STRING_INTERN_STATS.stored += 1;
  return value;
}

export function internSessionEntryLargeStrings(entry: SessionEntry): void {
  const snapshot = entry.skillsSnapshot;
  if (!snapshot?.prompt) {
    return;
  }
  // The live session store repeatedly clones a small set of large skills prompts.
  // Intern only that known high-duplication field so behavior and serialization stay unchanged.
  snapshot.prompt = internLargeSessionStoreString(snapshot.prompt);
}

export function internSessionStoreLargeStrings(store: Record<string, SessionEntry>): void {
  for (const entry of Object.values(store)) {
    internSessionEntryLargeStrings(entry);
  }
}

export function getSessionStoreStringInternStatsForTest(): {
  poolSize: number;
  stored: number;
  reused: number;
  skippedSmall: number;
  skippedFull: number;
  minChars: number;
  maxEntries: number;
} {
  return {
    poolSize: SESSION_STORE_STRING_INTERN_POOL.size,
    stored: SESSION_STORE_STRING_INTERN_STATS.stored,
    reused: SESSION_STORE_STRING_INTERN_STATS.reused,
    skippedSmall: SESSION_STORE_STRING_INTERN_STATS.skippedSmall,
    skippedFull: SESSION_STORE_STRING_INTERN_STATS.skippedFull,
    minChars: LARGE_SESSION_STORE_STRING_MIN_CHARS,
    maxEntries: LARGE_SESSION_STORE_STRING_MAX_INTERNED,
  };
}

export function getSerializedSessionStoreCacheStatsForTest(): {
  entries: number;
  totalBytes: number;
  maxEntries: number;
  maxBytes: number;
} {
  pruneSerializedSessionStoreCache();
  return {
    entries: SESSION_STORE_SERIALIZED_CACHE.size,
    totalBytes: sessionStoreSerializedCacheBytes,
    maxEntries: getSerializedSessionStoreCacheMaxEntries(),
    maxBytes: getSerializedSessionStoreCacheMaxBytes(),
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (!value || typeof value !== "object") {
    return value as DeepReadonly<T>;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value as DeepReadonly<T>;
  }
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

export function cloneSessionStoreRecord(
  store: Record<string, SessionEntry>,
  serialized?: string,
): Record<string, SessionEntry> {
  const cloned = JSON.parse(serialized ?? JSON.stringify(store)) as Record<string, SessionEntry>;
  internSessionStoreLargeStrings(cloned);
  return cloned;
}

function cloneJsonLikeValue<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonLikeValue(item)) as T;
  }
  const cloned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    cloned[key] = cloneJsonLikeValue(child);
  }
  return cloned as T;
}

export function cloneSessionStoreSnapshot(
  store: Record<string, SessionEntry>,
  serialized?: string,
): SessionStoreSnapshot {
  const cloned =
    serialized === undefined
      ? cloneJsonLikeValue(store)
      : cloneSessionStoreRecord(store, serialized);
  internSessionStoreLargeStrings(cloned);
  return deepFreeze(cloned);
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
  SESSION_STORE_SNAPSHOT_CACHE.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
  sessionStoreSerializedCacheBytes = 0;
  SESSION_STORE_STRING_INTERN_POOL.clear();
  resetSessionStoreStringInternStats();
}

export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SNAPSHOT_CACHE.delete(storePath);
  deleteSerializedSessionStore(storePath);
}

function deleteSerializedSessionStore(storePath: string): void {
  const cached = SESSION_STORE_SERIALIZED_CACHE.get(storePath);
  if (!cached) {
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
  sessionStoreSerializedCacheBytes -= cached.sizeBytes;
}

function pruneSerializedSessionStoreCache(): void {
  const maxEntries = getSerializedSessionStoreCacheMaxEntries();
  const maxBytes = getSerializedSessionStoreCacheMaxBytes();
  while (
    SESSION_STORE_SERIALIZED_CACHE.size > 0 &&
    (SESSION_STORE_SERIALIZED_CACHE.size > maxEntries ||
      sessionStoreSerializedCacheBytes > maxBytes)
  ) {
    const oldestKey = SESSION_STORE_SERIALIZED_CACHE.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    deleteSerializedSessionStore(oldestKey);
  }
}

export function getSerializedSessionStore(storePath: string): string | undefined {
  pruneSerializedSessionStoreCache();
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath)?.serialized;
}

export function setSerializedSessionStore(storePath: string, serialized?: string): void {
  deleteSerializedSessionStore(storePath);
  if (serialized === undefined) {
    return;
  }
  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  const maxEntries = getSerializedSessionStoreCacheMaxEntries();
  const maxBytes = getSerializedSessionStoreCacheMaxBytes();
  if (maxEntries <= 0 || maxBytes <= 0 || sizeBytes > maxBytes) {
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, { serialized, sizeBytes });
  sessionStoreSerializedCacheBytes += sizeBytes;
  pruneSerializedSessionStoreCache();
}

export function dropSessionStoreObjectCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

export function dropSessionStoreSnapshotCache(storePath: string): void {
  SESSION_STORE_SNAPSHOT_CACHE.delete(storePath);
}

export function readSessionStoreSnapshotCache(params: {
  storePath: string;
  mtimeMs?: number;
  sizeBytes?: number;
}): SessionStoreSnapshot | null {
  const cached = SESSION_STORE_SNAPSHOT_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  return cached.snapshot;
}

export function writeSessionStoreSnapshotCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
}): SessionStoreSnapshot {
  const snapshot = cloneSessionStoreSnapshot(params.store, params.serialized);
  SESSION_STORE_SNAPSHOT_CACHE.set(params.storePath, {
    snapshot,
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    generation: (sessionStoreSnapshotGeneration += 1),
    createdAt: Date.now(),
    entryCount: Object.keys(snapshot).length,
  });
  return snapshot;
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
  const store =
    params.serialized === undefined ? cloneSessionStoreRecord(params.store) : params.store;
  if (params.serialized !== undefined) {
    internSessionStoreLargeStrings(store);
  }
  SESSION_STORE_CACHE.set(params.storePath, {
    store,
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    serialized: params.serialized,
  });
  setSerializedSessionStore(params.storePath, params.serialized);
}
