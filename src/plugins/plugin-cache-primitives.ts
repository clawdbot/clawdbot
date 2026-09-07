// Defines bounded caches for plugin runtime results and schema validation.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";

/** Small process-local LRU cache for runtime registries and compiled validators. */
export class PluginLruCache<T> {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, T>();

  constructor(
    maxEntries: number,
    private readonly onRemove?: (value: T, cacheKey: string) => void,
  ) {
    this.#maxEntries = normalizeMaxEntries(maxEntries, 1);
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    const removed = [...this.#entries];
    this.#entries.clear();
    for (const [key, value] of removed) {
      this.onRemove?.(value, key);
    }
  }

  deleteValue(value: T): void {
    this.deleteWhere((entry) => entry === value);
  }

  deleteWhere(matches: (value: T) => boolean): void {
    const removed: [string, T][] = [];
    for (const [key, entry] of this.#entries) {
      if (matches(entry)) {
        this.#entries.delete(key);
        removed.push([key, entry]);
      }
    }
    for (const [key, value] of removed) {
      this.onRemove?.(value, key);
    }
  }

  /** Returns a cached value and refreshes its recency when present. */
  get(cacheKey: string): T | undefined {
    if (!this.#entries.has(cacheKey)) {
      return undefined;
    }
    const cached = this.#entries.get(cacheKey) as T;
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, cached);
    return cached;
  }

  /** Stores a value as the newest entry and evicts oldest entries past capacity. */
  set(cacheKey: string, value: T): void {
    const removed: [string, T][] = [];
    if (this.#entries.has(cacheKey)) {
      removed.push([cacheKey, this.#entries.get(cacheKey)!]);
      this.#entries.delete(cacheKey);
    }
    this.#entries.set(cacheKey, value);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.entries().next().value!;
      this.#entries.delete(oldest[0]);
      removed.push(oldest);
    }
    // All removals are visible before callbacks can reenter the cache.
    for (const [key, entry] of removed) {
      this.onRemove?.(entry, key);
    }
  }
}

/** Promise loader that coalesces concurrent loads per config object and for the default scope. */
type ConfigScopedPromiseLoader<T> = {
  load(config?: OpenClawConfig): Promise<T>;
  clear(): void;
};

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
