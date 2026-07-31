/** Manual-control promise cache for lazy runtime resources. */
export type LazyPromiseLoader<T> = {
  /** Resolves the cached value, creating one load promise when needed. */
  load: () => Promise<T>;
  /** Returns the current cached promise without starting a load. */
  peek: () => Promise<T> | undefined;
  /** Drops the cached promise so the next load starts fresh. */
  clear: () => void;
};

/** Returns the cached promise for a key, creating and storing it when absent. */
export function getOrCreatePromise<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  create: () => Promise<V>,
): Promise<V> {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const created = create();
  cache.set(key, created);
  return created;
}

/** Options for controlling lazy promise cache behavior. */
type LazyPromiseLoaderOptions = {
  /** Keep rejected promises cached instead of allowing the next caller to retry. */
  cacheRejections?: boolean;
};

/**
 * Creates a small promise cache that dedupes concurrent loads and can be cleared manually.
 *
 * Rejections are evicted by default so transient dynamic-import/runtime failures can recover.
 */
export function createLazyPromiseLoader<T>(
  load: () => T | Promise<T>,
  options: LazyPromiseLoaderOptions = {},
): LazyPromiseLoader<T> {
  let promise: Promise<T> | undefined;

  const createPromise = (): Promise<T> => {
    const loaded = Promise.resolve().then(load);
    if (options.cacheRejections !== true) {
      void loaded.catch(() => {
        // Failed lazy loads are usually transient import/runtime issues; evict the exact
        // rejected promise so the next caller can retry without racing a newer load.
        if (promise === loaded) {
          promise = undefined;
        }
      });
    }
    return loaded;
  };

  return {
    load(): Promise<T> {
      promise ??= createPromise();
      return promise;
    },
    peek(): Promise<T> | undefined {
      return promise;
    },
    clear(): void {
      promise = undefined;
    },
  };
}

/** Creates a reusable function that resolves one cached promise at a time. */
export function createLazyPromise<T>(
  load: () => T | Promise<T>,
  options?: LazyPromiseLoaderOptions,
): () => Promise<T> {
  const loader = createLazyPromiseLoader(load, options);
  return () => loader.load();
}

/** Convenience wrapper for dynamic-import-shaped loaders. */
export function createLazyImportLoader<T>(
  load: () => Promise<T>,
  options?: LazyPromiseLoaderOptions,
): LazyPromiseLoader<T> {
  return createLazyPromiseLoader(load, options);
}
