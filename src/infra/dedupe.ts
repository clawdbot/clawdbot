import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { pruneMapToMaxSize } from "./map-size.js";
import { resolveNonNegativeIntegerOption } from "./numeric-options.js";

export type DedupeCache = {
  check: (key: string | undefined | null, now?: number) => boolean;
  peek: (key: string | undefined | null, now?: number) => boolean;
  delete: (key: string | undefined | null) => void;
  clear: () => void;
  size: () => number;
};

export type DedupeCacheOptions = {
  ttlMs: number;
  maxSize: number;
};

/** @deprecated Use resolveNonNegativeIntegerOption for new internal numeric option normalization. */
export { resolveNonNegativeIntegerOption as resolveDedupeNonNegativeInteger };

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

export function resolveGlobalDedupeCache(key: symbol, options: DedupeCacheOptions): DedupeCache {
  return resolveGlobalSingleton(key, () => createDedupeCache(options));
}
