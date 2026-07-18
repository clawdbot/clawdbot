import { expectDefined } from "@openclaw/normalization-core";
// Session store caches share parsed stores, immutable snapshots, and serialized JSON.
import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";
import { createExpiringMapCache, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import { clearSessionSkillPromptRefCache } from "./skill-prompt-blobs.js";
import type { SessionEntry, SessionSkillPromptRef } from "./types.js";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type SessionStoreSnapshotEntry = DeepReadonly<SessionEntry>;

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  ctimeNs?: bigint;
  mtimeNs?: bigint;
  sizeBytes?: number;
  serialized?: string;
};

type SerializedSessionStoreCacheEntry = {
  serialized: string;
  sizeBytes: number;
  promptRefs?: ReadonlyMap<string, SessionSkillPromptRef>;
};

const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)
const DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_ENTRIES = 64;
const DEFAULT_SESSION_STORE_SERIALIZED_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const LARGE_SESSION_STORE_STRING_MIN_CHARS = 512;
const LARGE_SESSION_STORE_STRING_MAX_INTERNED = 256;

const SESSION_STORE_CACHE = createExpiringMapCache<string, SessionStoreCacheEntry>({
  ttlMs: getSessionStoreTtl,
});
const SESSION_STORE_CACHE_VERSION = new Map<string, number>();
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, SerializedSessionStoreCacheEntry>();
const SESSION_STORE_STRING_INTERN_POOL = new Map<string, string>();
const SESSION_STORE_STRING_INTERN_STATS = {
  stored: 0,
  reused: 0,
  skippedSmall: 0,
  skippedFull: 0,
};
let sessionStoreSerializedCacheBytes = 0;

function parseNonNegativeInteger(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return parseStrictNonNegativeInteger(trimmed) ?? null;
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

function internSessionStoreLargeStrings(store: Record<string, SessionEntry>): void {
  for (const entry of Object.values(store)) {
    internSessionEntryLargeStrings(entry);
  }
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
  // When serialized JSON is already available, parse it instead of deep-cloning field-by-field.
  const cloned =
    serialized === undefined
      ? cloneJsonLikeValue(store)
      : (JSON.parse(serialized) as Record<string, SessionEntry>);
  internSessionStoreLargeStrings(cloned);
  return cloned;
}

function cloneJsonLikeValue<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const cloned: unknown[] = [];
    cloned.length = value.length;
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        continue;
      }
      cloned[index] = cloneJsonLikeValue(value[index]);
    }
    return cloned as T;
  }
  const cloned: Record<string, unknown> = {};
  for (const key in value as Record<string, unknown>) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) {
      continue;
    }
    const clonedChild = cloneJsonLikeValue(child);
    if (key === "__proto__") {
      // Preserve JSON object shape without letting `__proto__` mutate the clone prototype.
      Object.defineProperty(cloned, key, {
        value: clonedChild,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      cloned[key] = clonedChild;
    }
  }
  return cloned as T;
}

export function cloneSessionStoreSnapshotEntry(entry: SessionEntry): SessionStoreSnapshotEntry {
  return deepFreeze(
    expectDefined(cloneSessionStoreRecord({ entry }).entry, "cloned session cache entry"),
  );
}

function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.OPENCLAW_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

export function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

function bumpSessionStoreCacheVersion(storePath: string): void {
  SESSION_STORE_CACHE_VERSION.set(storePath, (SESSION_STORE_CACHE_VERSION.get(storePath) ?? 0) + 1);
}

export function getSessionStoreCacheVersion(storePath: string): number {
  return SESSION_STORE_CACHE_VERSION.get(storePath) ?? 0;
}

export function clearSessionStoreCaches(): void {
  SESSION_STORE_CACHE.clear();
  SESSION_STORE_CACHE_VERSION.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
  sessionStoreSerializedCacheBytes = 0;
  SESSION_STORE_STRING_INTERN_POOL.clear();
  clearSessionSkillPromptRefCache();
  resetSessionStoreStringInternStats();
}

export function invalidateSessionStoreCache(storePath: string): void {
  bumpSessionStoreCacheVersion(storePath);
  SESSION_STORE_CACHE.delete(storePath);
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
    // Map insertion order gives us a tiny LRU-ish eviction policy without extra bookkeeping.
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

export function getSerializedSessionStorePromptRefs(
  storePath: string,
): ReadonlyMap<string, SessionSkillPromptRef> | undefined {
  pruneSerializedSessionStoreCache();
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath)?.promptRefs;
}

export function setSerializedSessionStorePromptRefs(
  storePath: string,
  promptRefs: ReadonlyMap<string, SessionSkillPromptRef>,
): void {
  pruneSerializedSessionStoreCache();
  const cached = SESSION_STORE_SERIALIZED_CACHE.get(storePath);
  if (!cached) {
    return;
  }
  cached.promptRefs = promptRefs;
}

export function setSerializedSessionStore(
  storePath: string,
  serialized?: string,
  sizeBytesHint?: number,
  promptRefs?: ReadonlyMap<string, SessionSkillPromptRef>,
): void {
  deleteSerializedSessionStore(storePath);
  if (serialized === undefined) {
    return;
  }
  const sizeBytes =
    typeof sizeBytesHint === "number" && Number.isFinite(sizeBytesHint) && sizeBytesHint >= 0
      ? sizeBytesHint
      : Buffer.byteLength(serialized, "utf8");
  const maxEntries = getSerializedSessionStoreCacheMaxEntries();
  const maxBytes = getSerializedSessionStoreCacheMaxBytes();
  if (maxEntries <= 0 || maxBytes <= 0 || sizeBytes > maxBytes) {
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, { serialized, sizeBytes, promptRefs });
  sessionStoreSerializedCacheBytes += sizeBytes;
  pruneSerializedSessionStoreCache();
}

export function dropSessionStoreObjectCache(storePath: string): void {
  bumpSessionStoreCacheVersion(storePath);
  SESSION_STORE_CACHE.delete(storePath);
}

export function readSessionStoreCache(params: {
  storePath: string;
  ctimeNs?: bigint;
  mtimeNs?: bigint;
  sizeBytes?: number;
  clone?: boolean;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  if (
    params.ctimeNs !== cached.ctimeNs ||
    params.mtimeNs !== cached.mtimeNs ||
    params.sizeBytes !== cached.sizeBytes
  ) {
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
  ctimeNs?: bigint;
  mtimeNs?: bigint;
  sizeBytes?: number;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  if (
    params.ctimeNs !== cached.ctimeNs ||
    params.mtimeNs !== cached.mtimeNs ||
    params.sizeBytes !== cached.sizeBytes
  ) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  SESSION_STORE_CACHE.delete(params.storePath);
  return cached.store;
}

export function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  ctimeNs?: bigint;
  mtimeNs?: bigint;
  sizeBytes?: number;
  serialized?: string;
  serializedPromptRefs?: ReadonlyMap<string, SessionSkillPromptRef>;
  cloneSerialized?: string;
  takeOwnership?: boolean;
}): void {
  bumpSessionStoreCacheVersion(params.storePath);
  const store =
    params.takeOwnership === true ? params.store : cloneSessionStoreRecord(params.store);
  // Ownership is only taken for freshly parsed store objects that no caller will mutate afterward.
  if (params.takeOwnership === true) {
    internSessionStoreLargeStrings(store);
  }
  SESSION_STORE_CACHE.set(params.storePath, {
    store,
    ctimeNs: params.ctimeNs,
    mtimeNs: params.mtimeNs,
    sizeBytes: params.sizeBytes,
    serialized: params.cloneSerialized,
  });
  setSerializedSessionStore(
    params.storePath,
    params.serialized,
    params.sizeBytes,
    params.serializedPromptRefs,
  );
}
