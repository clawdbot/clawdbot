/** Cache state helper for plugin loader registries, in-flight loads, and warning suppression. */
import { PluginLruCache } from "./plugin-cache-primitives.js";

/** Error thrown when one plugin registry cache key attempts nested loading. */
class PluginLoadReentryError extends Error {
  readonly cacheKey: string;

  constructor(cacheKey: string) {
    super(`plugin load reentry detected for cache key: ${cacheKey}`);
    this.name = "PluginLoadReentryError";
    this.cacheKey = cacheKey;
  }
}

/** Small registry cache with reentry detection and per-key warning memory. */
export class PluginLoaderCacheState<T> {
  readonly #registryCache: PluginLruCache<{ value: T; claim?: { release(): void } }>;
  readonly #inFlightLoads = new Set<string>();
  readonly #openAllowlistWarningCache: PluginLruCache<true>;

  constructor(
    defaultMaxEntries: number,
    private readonly retain?: (state: T) => { release(): void },
  ) {
    this.#registryCache = new PluginLruCache(defaultMaxEntries, (entry) => entry.claim?.release());
    this.#openAllowlistWarningCache = new PluginLruCache<true>(defaultMaxEntries);
  }

  clear(): void {
    this.#registryCache.clear();
    this.#inFlightLoads.clear();
    this.#openAllowlistWarningCache.clear();
  }

  clearCachedRegistries(): void {
    this.#registryCache.clear();
    this.#openAllowlistWarningCache.clear();
  }

  get(cacheKey: string): T | undefined {
    return this.#registryCache.get(cacheKey)?.value;
  }

  set(cacheKey: string, state: T): void {
    const claim = this.retain?.(state);
    this.#registryCache.set(cacheKey, { value: state, claim });
  }

  deleteValue(state: T): void {
    this.#registryCache.deleteWhere((entry) => entry.value === state);
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
    return this.#openAllowlistWarningCache.get(cacheKey) === true;
  }

  recordOpenAllowlistWarning(cacheKey: string): void {
    this.#openAllowlistWarningCache.set(cacheKey, true);
  }
}
