// Defines lifecycle-owned cache primitives for plugin metadata.
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Result shape for cache lookups that need to distinguish a miss from cached `undefined`. */
export type PluginLruCacheResult<T> = { hit: true; value: T } | { hit: false };

/** Small process-local LRU cache used for stable plugin metadata and loader artifacts. */
export class PluginLruCache<T> {
  readonly #defaultMaxEntries: number;
  #maxEntries: number;
  readonly #entries = new Map<string, T>();

  constructor(defaultMaxEntries: number) {
    this.#defaultMaxEntries = normalizeMaxEntries(defaultMaxEntries, 1);
    this.#maxEntries = this.#defaultMaxEntries;
  }

  get maxEntries(): number {
    return this.#maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  setMaxEntriesForTest(value?: number): void {
    this.#maxEntries =
      typeof value === "number"
        ? normalizeMaxEntries(value, this.#defaultMaxEntries)
        : this.#defaultMaxEntries;
    this.#evictOldestEntries();
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Returns a cached value and refreshes its recency when present. */
  get(cacheKey: string): T | undefined {
    const cached = this.getResult(cacheKey);
    return cached.hit ? cached.value : undefined;
  }

  /** Returns a hit/miss result and promotes hits to the newest LRU position. */
  getResult(cacheKey: string): PluginLruCacheResult<T> {
    if (!this.#entries.has(cacheKey)) {
      return { hit: false };
    }
    const cached = this.#entries.get(cacheKey) as T;
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, cached);
    return { hit: true, value: cached };
  }

  /** Stores a value as the newest entry and evicts oldest entries past capacity. */
  set(cacheKey: string, value: T): void {
    if (this.#entries.has(cacheKey)) {
      this.#entries.delete(cacheKey);
    }
    this.#entries.set(cacheKey, value);
    this.#evictOldestEntries();
  }

  #evictOldestEntries(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldestEntry = this.#entries.keys().next();
      if (oldestEntry.done) {
        break;
      }
      this.#entries.delete(oldestEntry.value);
    }
  }
}

/** Runtime cache partitioned by config object identity so request-scoped configs do not collide. */
export type ConfigScopedRuntimeCache<T> = WeakMap<OpenClawConfig, Map<string, T>>;

/** Promise loader that coalesces concurrent loads per config object and for the default scope. */
export type ConfigScopedPromiseLoader<T> = {
  load(config?: OpenClawConfig): Promise<T>;
  clear(): void;
};

/** Resolves a config-scoped cached value; calls without config intentionally bypass caching. */
export function resolveConfigScopedRuntimeCacheValue<T>(params: {
  cache: ConfigScopedRuntimeCache<T>;
  config?: OpenClawConfig;
  key: string;
  load: () => T;
}): T {
  if (!params.config) {
    return params.load();
  }
  let configCache = params.cache.get(params.config);
  if (!configCache) {
    configCache = new Map();
    params.cache.set(params.config, configCache);
  }
  if (configCache.has(params.key)) {
    return configCache.get(params.key) as T;
  }
  const loaded = params.load();
  configCache.set(params.key, loaded);
  return loaded;
}

/** Encodes structured cache dimensions without separator ambiguity. */
export function createPluginCacheKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

/** Creates a config-scoped promise cache that drops rejected loads so callers can retry. */
export function createConfigScopedPromiseLoader<T>(
  load: (config?: OpenClawConfig) => T | Promise<T>,
): ConfigScopedPromiseLoader<T> {
  let defaultPromise: Promise<T> | undefined;
  let promisesByConfig = new WeakMap<OpenClawConfig, Promise<T>>();

  const createPromise = (config?: OpenClawConfig): Promise<T> => {
    const promise = Promise.resolve().then(() => load(config));
    void promise.catch(() => {
      if (config) {
        promisesByConfig.delete(config);
      } else if (defaultPromise === promise) {
        defaultPromise = undefined;
      }
    });
    return promise;
  };

  return {
    async load(config?: OpenClawConfig): Promise<T> {
      if (!config) {
        defaultPromise ??= createPromise();
        return await defaultPromise;
      }
      const cached = promisesByConfig.get(config);
      if (cached) {
        return await cached;
      }
      const promise = createPromise(config);
      promisesByConfig.set(config, promise);
      return await promise;
    },
    clear(): void {
      defaultPromise = undefined;
      promisesByConfig = new WeakMap<OpenClawConfig, Promise<T>>();
    },
  };
}

function normalizeMaxEntries(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}
