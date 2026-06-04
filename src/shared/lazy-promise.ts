/** Manual-control promise cache for lazy runtime resources. */
export type LazyPromiseLoader<T> = {
  /** Resolves the cached value, creating one load promise when needed. */
  load(): Promise<T>;
  /** Drops the cached promise so the next load starts fresh. */
  clear(): void;
};

/** Options for controlling lazy promise cache behavior. */
export type LazyPromiseLoaderOptions = {
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
    async load(): Promise<T> {
      promise ??= createPromise();
      return await promise;
    },
    clear(): void {
      promise = undefined;
    },
  };
}

/** Convenience wrapper for dynamic-import-shaped loaders. */
export function createLazyImportLoader<T>(
  load: () => Promise<T>,
  options?: LazyPromiseLoaderOptions,
): LazyPromiseLoader<T> {
  return createLazyPromiseLoader(load, options);
}
