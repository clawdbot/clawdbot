export type LazyPromiseLoader<T> = {
  load(): Promise<T>;
  clear(): void;
};

export type LazyPromiseLoaderOptions = {
  cacheRejections?: boolean;
};

export function createLazyPromiseLoader<T>(
  load: () => T | Promise<T>,
  options: LazyPromiseLoaderOptions = {},
): LazyPromiseLoader<T> {
  let promise: Promise<T> | undefined;

  const createPromise = (): Promise<T> => {
    const loaded = Promise.resolve().then(load);
    if (options.cacheRejections !== true) {
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

export function createLazyImportLoader<T>(
  load: () => Promise<T>,
  options?: LazyPromiseLoaderOptions,
): LazyPromiseLoader<T> {
  return createLazyPromiseLoader(load, options);
}
