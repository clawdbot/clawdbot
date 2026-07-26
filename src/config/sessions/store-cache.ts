// Session store cache retains parsed SQLite rows for repeated gateway listings.
import { createExpiringMapCache } from "../cache-utils.js";
import type { SessionEntry } from "./types.js";

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  orderedSessionKeys?: readonly string[];
  ctimeNs?: bigint;
  mtimeNs?: bigint;
  sizeBytes?: number;
  dataVersion?: number;
  /** Monotonic connection identity token — bumps on handle close+reopen to
   *  guard against data_version cross-connection coincidence. */
  connectionToken?: number;
};

const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)

const SESSION_STORE_CACHE = createExpiringMapCache<string, SessionStoreCacheEntry>({
  ttlMs: DEFAULT_SESSION_STORE_TTL_MS,
});

export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

export function readSessionStoreCache(params: {
  storePath: string;
  ctimeNs?: bigint;
  mtimeNs?: bigint;
  sizeBytes?: number;
  dataVersion?: number;
  connectionToken?: number;
}): { store: Record<string, SessionEntry>; orderedSessionKeys?: readonly string[] } | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  if (
    params.ctimeNs !== cached.ctimeNs ||
    params.mtimeNs !== cached.mtimeNs ||
    params.sizeBytes !== cached.sizeBytes ||
    params.dataVersion !== cached.dataVersion ||
    params.connectionToken !== cached.connectionToken
  ) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  return { store: cached.store, orderedSessionKeys: cached.orderedSessionKeys };
}

export function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  orderedSessionKeys?: readonly string[];
  ctimeNs?: bigint;
  mtimeNs?: bigint;
  sizeBytes?: number;
  dataVersion?: number;
  connectionToken?: number;
}): void {
  // The accessor transfers freshly parsed rows; no caller can mutate them after this point.
  SESSION_STORE_CACHE.set(params.storePath, {
    store: params.store,
    orderedSessionKeys: params.orderedSessionKeys?.slice(),
    ctimeNs: params.ctimeNs,
    mtimeNs: params.mtimeNs,
    sizeBytes: params.sizeBytes,
    dataVersion: params.dataVersion,
    connectionToken: params.connectionToken,
  });
}
