// Generic cache storage stays independent of plugin lifecycle owners.
import { pruneMapToMaxSize } from "../infra/map-size.js";

/** Small process-local LRU cache for runtime registries and compiled validators. */
export class PluginLruCache<T> {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, T>();

  constructor(maxEntries: number) {
    this.#maxEntries =
      Number.isFinite(maxEntries) && maxEntries > 0 ? Math.max(1, Math.floor(maxEntries)) : 1;
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
    if (!this.#entries.has(cacheKey)) {
      return undefined;
    }
    // SAFETY: has() proved the key exists; undefined remains a valid cached T.
    const cached = this.#entries.get(cacheKey) as T;
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, cached);
    return cached;
  }

  /** Stores a value as the newest entry and evicts oldest entries past capacity. */
  set(cacheKey: string, value: T): void {
    this.#entries.delete(cacheKey);
    this.#entries.set(cacheKey, value);
    pruneMapToMaxSize(this.#entries, this.#maxEntries);
  }
}
