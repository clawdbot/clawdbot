// Defines bounded caches for plugin runtime results and schema validation.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";

/** Result shape for cache lookups that need to distinguish a miss from cached `undefined`. */
type PluginLruCacheResult<T> = { hit: true; value: T } | { hit: false };

/** Small process-local LRU cache for runtime registries and compiled validators. */
export class PluginLruCache<T> {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, T>();

  constructor(maxEntries: number) {
    this.#maxEntries = normalizeMaxEntries(maxEntries, 1);
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  deleteValue(value: T): void {
    for (const [key, entry] of this.#entries) {
      if (entry === value) {
        this.#entries.delete(key);
      }
    }
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
    pruneMapToMaxSize(this.#entries, this.#maxEntries);
  }
}

/** Runtime cache partitioned by config object identity so request-scoped configs do not collide. */
export type ConfigScopedRuntimeCache<T> = WeakMap<OpenClawConfig, Map<string, T>>;

/** Promise loader that coalesces concurrent loads per config object and for the default scope. */
type ConfigScopedPromiseLoader<T> = {
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
        if (promisesByConfig.get(config) === promise) {
          promisesByConfig.delete(config);
        }
      } else if (defaultPromise === promise) {
        defaultPromise = undefined;
      }
    });
    return promise;
  };

  const loader: ConfigScopedPromiseLoader<T> = {
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
  // Resolved values can retain executable plugin callbacks past install, replacement, or removal.
  registerPluginMetadataProcessMemoLifecycleClear(() => loader.clear());
  return loader;
}

function normalizeMaxEntries(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}
