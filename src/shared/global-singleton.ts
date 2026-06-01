/** Resolves a process-local singleton for caches and registries that tolerate helper lookup. */
export function resolveGlobalSingleton<T>(key: symbol, create: () => T): T {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (Object.hasOwn(globalStore, key)) {
    return globalStore[key] as T;
  }
  const created = create();
  globalStore[key] = created;
  return created;
}

/** Resolves a process-local Map singleton for keyed caches backed by globalThis. */
export function resolveGlobalMap<TKey, TValue>(key: symbol): Map<TKey, TValue> {
  return resolveGlobalSingleton(key, () => new Map<TKey, TValue>());
}
