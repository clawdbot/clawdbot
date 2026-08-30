/**
 * Public SDK helper for caching a lazily computed value behind a getter.
 */
type LazyValue<T> = T | (() => T);

/** Returns a getter that resolves the supplied value at most once. */
export function createCachedLazyValueGetter<T>(value: LazyValue<T>): () => T {
  let resolved = false;
  let cached!: T;

  return () => {
    if (!resolved) {
      cached = typeof value === "function" ? (value as () => T)() : value;
      resolved = true;
    }
    return cached;
  };
}
