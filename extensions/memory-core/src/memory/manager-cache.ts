import { resolveGlobalSingleton } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

type Closable = {
  close?: () => Promise<void> | void;
};

export type ManagedCache<T> = {
  cache: Map<string, T>;
  pending: Map<string, Promise<T>>;
};

export function resolveSingletonManagedCache<T>(cacheKey: symbol): ManagedCache<T> {
  const resolved = resolveGlobalSingleton<unknown>(cacheKey, () => ({
    cache: new Map<string, T>(),
    pending: new Map<string, Promise<T>>(),
  }));
  if (
    typeof resolved === "object" &&
    resolved !== null &&
    (resolved as Partial<ManagedCache<T>>).cache instanceof Map &&
    (resolved as Partial<ManagedCache<T>>).pending instanceof Map
  ) {
    return resolved as ManagedCache<T>;
  }
  const repaired: ManagedCache<T> = {
    cache: new Map<string, T>(),
    pending: new Map<string, Promise<T>>(),
  };
  (globalThis as Record<PropertyKey, unknown>)[cacheKey] = repaired;
  return repaired;
}

export async function getOrCreateManagedCacheEntry<T>(params: {
  cache: Map<string, T>;
  pending: Map<string, Promise<T>>;
  key: string;
  bypassCache?: boolean;
  create: () => Promise<T> | T;
}): Promise<T> {
  if (params.bypassCache) {
    return await params.create();
  }
  const existing = params.cache.get(params.key);
  if (existing) {
    return existing;
  }
  const pending = params.pending.get(params.key);
  if (pending) {
    return pending;
  }
  const createPromise = (async () => {
    const refreshed = params.cache.get(params.key);
    if (refreshed) {
      return refreshed;
    }
    const entry = await params.create();
    params.cache.set(params.key, entry);
    return entry;
  })();
  params.pending.set(params.key, createPromise);
  try {
    return await createPromise;
  } finally {
    if (params.pending.get(params.key) === createPromise) {
      params.pending.delete(params.key);
    }
  }
}

export async function closeManagedCacheEntries<T extends Closable>(params: {
  cache: Map<string, T>;
  pending: Map<string, Promise<T>>;
  onCloseError?: (err: unknown) => void;
}): Promise<void> {
  const pending = Array.from(params.pending.values());
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  const entries = Array.from(params.cache.values());
  params.cache.clear();
  for (const entry of entries) {
    if (typeof entry.close !== "function") {
      continue;
    }
    try {
      await entry.close();
    } catch (err) {
      params.onCloseError?.(err);
    }
  }
}
