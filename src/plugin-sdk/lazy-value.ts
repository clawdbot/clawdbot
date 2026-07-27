/**
 * Public SDK helper for caching a lazily computed value behind a getter.
 */
type LazyValue<T> = T | (() => T);

/** Returns a getter that resolves the supplied value at most once. */
export function createCachedLazyValueGetter<T>(value: LazyValue<T>): () => T;
/** Returns a getter that resolves once and substitutes a fallback for nullish values. */
export function createCachedLazyValueGetter<T>(
  value: LazyValue<T | null | undefined>,
  fallback: T,
): () => T;
export function createCachedLazyValueGetter<T>(
  value: LazyValue<T | null | undefined>,
  fallback?: T,
): () => T | undefined {
  let resolved = false;
  let cached: T | undefined;

  return () => {
    if (!resolved) {
      const nextValue =
        typeof value === "function" ? (value as () => T | null | undefined)() : value;
      cached = nextValue ?? fallback;
      resolved = true;
    }
    return cached;
  };
}
