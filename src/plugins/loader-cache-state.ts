import { PluginLruCache } from "./plugin-lru-cache.js";

export class PluginLoadReentryError extends Error {
  readonly cacheKey: string;

  constructor(cacheKey: string) {
    super(`plugin load reentry detected for cache key: ${cacheKey}`);
    this.name = "PluginLoadReentryError";
    this.cacheKey = cacheKey;
  }
}

export class PluginLoaderCacheState<T> {
  readonly #registryCache: PluginLruCache<T>;
  readonly #inFlightLoads = new Set<string>();
  readonly #openAllowlistWarningCache = new Set<string>();

  constructor(defaultMaxEntries: number) {
    this.#registryCache = new PluginLruCache<T>(defaultMaxEntries);
  }

  get maxEntries(): number {
    return this.#registryCache.maxEntries;
  }

  setMaxEntriesForTest(value?: number): void {
    this.#registryCache.setMaxEntriesForTest(value);
  }

  clear(): void {
    this.#registryCache.clear();
    this.#inFlightLoads.clear();
    this.#openAllowlistWarningCache.clear();
  }

  get(cacheKey: string): T | undefined {
    return this.#registryCache.get(cacheKey);
  }

  set(cacheKey: string, state: T): void {
    this.#registryCache.set(cacheKey, state);
  }

  isLoadInFlight(cacheKey: string): boolean {
    return this.#inFlightLoads.has(cacheKey);
  }

  beginLoad(cacheKey: string): void {
    if (this.#inFlightLoads.has(cacheKey)) {
      throw new PluginLoadReentryError(cacheKey);
    }
    this.#inFlightLoads.add(cacheKey);
  }

  finishLoad(cacheKey: string): void {
    this.#inFlightLoads.delete(cacheKey);
  }

  hasOpenAllowlistWarning(cacheKey: string): boolean {
    return this.#openAllowlistWarningCache.has(cacheKey);
  }

  recordOpenAllowlistWarning(cacheKey: string): void {
    this.#openAllowlistWarningCache.add(cacheKey);
  }
}
