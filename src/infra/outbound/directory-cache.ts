// Directory cache stores short-lived projections partitioned by config identity.
import { resolveNonNegativeIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../map-size.js";

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
};

/**
 * Stable dimensions that partition channel-directory cache entries.
 */
type DirectoryCacheKey = {
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  source: "cache" | "live";
  signature?: string | null;
  query?: string | null;
};

/**
 * Serializes channel-directory lookup dimensions into a cache key.
 */
export function buildDirectoryCacheKey(key: DirectoryCacheKey): string {
  const signature = key.signature ?? "default";
  return `${key.channel}:${key.accountId ?? "default"}:${key.kind}:${key.source}:${signature}:query:${key.query ?? ""}`;
}

/**
 * Small TTL cache for channel directory lookups tied to a config object reference.
 */
export class DirectoryCache<T> {
  private cachesByConfig = new WeakMap<OpenClawConfig, Map<string, CacheEntry<T>>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number, maxSize = 2000) {
    this.ttlMs = resolveNonNegativeIntegerOption(ttlMs, 0);
    this.maxSize = Math.max(1, resolveNonNegativeIntegerOption(maxSize, 2000));
  }

  /**
   * Returns a cached value after applying config scoping, TTL, and capacity invalidation.
   */
  get(key: string, cfg: OpenClawConfig): T | undefined {
    const cache = this.cacheForConfig(cfg);
    this.pruneExpired(cache, Date.now());
    const entry = cache.get(key);
    if (!entry) {
      return undefined;
    }
    return entry.value;
  }

  /**
   * Stores a value and refreshes its recency for bounded-size eviction.
   */
  set(key: string, value: T, cfg: OpenClawConfig): void {
    const cache = this.cacheForConfig(cfg);
    const now = Date.now();
    this.pruneExpired(cache, now);
    // Refresh insertion order so active keys are less likely to be evicted.
    cache.delete(key);
    cache.set(key, { value, fetchedAt: now });
    pruneMapToMaxSize(cache, this.maxSize);
  }

  /**
   * Clears matching entries without disturbing unrelated cached lookups.
   */
  clearMatching(match: (key: string) => boolean, cfg: OpenClawConfig): void {
    const cache = this.cachesByConfig.get(cfg);
    if (!cache) {
      return;
    }
    for (const key of cache.keys()) {
      if (match(key)) {
        cache.delete(key);
      }
    }
  }

  /**
   * Drops one config scope or all cached entries.
   */
  clear(cfg?: OpenClawConfig): void {
    if (cfg) {
      this.cachesByConfig.delete(cfg);
    } else {
      this.cachesByConfig = new WeakMap();
    }
  }

  private cacheForConfig(cfg: OpenClawConfig): Map<string, CacheEntry<T>> {
    let cache = this.cachesByConfig.get(cfg);
    if (!cache) {
      cache = new Map();
      this.cachesByConfig.set(cfg, cache);
    }
    return cache;
  }

  private pruneExpired(cache: Map<string, CacheEntry<T>>, now: number): void {
    if (this.ttlMs <= 0) {
      return;
    }
    for (const [cacheKey, entry] of cache) {
      if (now - entry.fetchedAt >= this.ttlMs) {
        cache.delete(cacheKey);
      }
    }
  }
}
