// Provides small process-local dedupe caches.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { pruneMapToMaxSize } from "./map-size.js";
import { resolveNonNegativeIntegerOption } from "./numeric-options.js";

/** Small in-memory TTL/LRU-style cache for replay and duplicate suppression. */
export type DedupeCache = {
  /** Returns true for a recent duplicate; records the key when it was not present. */
  check: (key: string | undefined | null, now?: number) => boolean;
  /** Returns true for a recent duplicate without refreshing or recording the key. */
  peek: (key: string | undefined | null, now?: number) => boolean;
  delete: (key: string | undefined | null) => void;
  clear: () => void;
  size: () => number;
};

/** Dedupe cache bounds; ttlMs <= 0 disables expiry, maxSize <= 0 disables storage. */
export type DedupeCacheOptions = {
  ttlMs: number;
  maxSize: number;
};

/** @deprecated Use resolveNonNegativeIntegerOption for new internal numeric option normalization. */
export { resolveNonNegativeIntegerOption as resolveDedupeNonNegativeInteger };

/** Creates a bounded in-memory dedupe cache with optional TTL expiry. */
export function createDedupeCache(options: DedupeCacheOptions): DedupeCache {
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const maxSize = resolveNonNegativeIntegerOption(options.maxSize, 0);
  const cache = new Map<string, number>();

  const touch = (key: string, now: number) => {
    cache.delete(key);
    cache.set(key, now);
  };

  const prune = (now: number) => {
    const cutoff = ttlMs > 0 ? now - ttlMs : undefined;
    if (cutoff !== undefined) {
      for (const [entryKey, entryTs] of cache) {
        if (entryTs < cutoff) {
          cache.delete(entryKey);
        }
      }
    }
    if (maxSize <= 0) {
      cache.clear();
      return;
    }
    pruneMapToMaxSize(cache, maxSize);
  };

  const hasUnexpired = (key: string, now: number, touchOnRead: boolean): boolean => {
    const existing = cache.get(key);
    if (existing === undefined) {
      return false;
    }
    if (ttlMs > 0 && now - existing >= ttlMs) {
      cache.delete(key);
      return false;
    }
    if (touchOnRead) {
      // check() refreshes recency so active duplicate bursts keep their key near the LRU tail.
      touch(key, now);
    }
    return true;
  };

  return {
    check: (key, now = Date.now()) => {
      if (!key) {
        return false;
      }
      if (hasUnexpired(key, now, true)) {
        return true;
      }
      touch(key, now);
      prune(now);
      return false;
    },
    peek: (key, now = Date.now()) => {
      if (!key) {
        return false;
      }
      return hasUnexpired(key, now, false);
    },
    delete: (key) => {
      if (!key) {
        return;
      }
      cache.delete(key);
    },
    clear: () => {
      cache.clear();
    },
    size: () => cache.size,
  };
}

/** Resolves a process-global dedupe cache for hot paths that can load this module twice. */
export function resolveGlobalDedupeCache(key: symbol, options: DedupeCacheOptions): DedupeCache {
  return resolveGlobalSingleton(key, () => createDedupeCache(options));
}
