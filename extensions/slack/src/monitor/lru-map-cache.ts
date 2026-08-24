import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";

/** LRU-touch read: move hit to newest so pruneMapToMaxSize keeps active keys. */
export function readLruMapEntry<T>(cache: Map<string, T>, cacheKey: string): T | undefined {
  const cached = cache.get(cacheKey);
  if (cached) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
  }
  return cached;
}

export function writeLruMapEntry<T>(
  cache: Map<string, T>,
  cacheKey: string,
  entry: T,
  maxEntries: number,
): void {
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  pruneMapToMaxSize(cache, maxEntries);
}
