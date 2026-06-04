/** Cached async loader used by runtime boundaries that should import on first use. */
export type LazyPromiseLoader<T> = {
  load(): Promise<T>;
  clear(): void;
};

/** Controls whether a failed first import stays cached or is retried later. */
export type LazyPromiseLoaderOptions = {
  cacheRejections?: boolean;
};

/** Creates a single-flight promise cache around a lazy import or other async loader. */
export function createLazyImportLoader<T>(
  load: () => Promise<T>,
  options: LazyPromiseLoaderOptions = {},
): LazyPromiseLoader<T> {
  let promise: Promise<T> | undefined;

  const createPromise = (): Promise<T> => {
    const loaded = Promise.resolve().then(load);
    if (options.cacheRejections !== true) {
      // Failed optional-runtime imports should retry after install/config changes.
      void loaded.catch(() => {
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
