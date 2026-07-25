// In-memory dedupe helpers for plugin runtime hot paths.

import { resolveGlobalDedupeCache } from "../infra/dedupe.js";
import type { OpenKeyedStoreOptions } from "./plugin-state-runtime.js";

export { createDedupeCache, resolveGlobalDedupeCache } from "../infra/dedupe.js";

type PersistentDedupeStore<TRecord> = {
  register(key: string, value: TRecord, opts?: { ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<TRecord | undefined>;
};

/** Dual-layer presence cache: process-memory dedupe plus best-effort persistent state. */
export type PersistentDedupeCache<TRecord> = {
  /** Memory-only presence check without refreshing recency. */
  peek(key: string): boolean;
  /** Memory-first presence check; falls back to persistence and re-primes memory on a hit. */
  lookup(key: string): Promise<boolean>;
  /** Records presence in memory and best-effort persistence. Never rejects. */
  register(key: string, record: TRecord, opts?: { at?: number }): Promise<void>;
  /** Clears memory and re-enables a persistent layer disabled by an earlier failure. */
  clearForTest(): void;
};

/**
 * Creates a channel-family presence cache backed by a global in-memory dedupe layer
 * plus a lazily opened plugin keyed store. Persistence is best effort: the first
 * open/read/write failure disables the persistent layer for the process so message
 * handling never breaks on state errors, matching the shipped channel-cache contract.
 */
export function createPersistentDedupeCache<TRecord>(params: {
  /** Global symbol key so the memory layer stays shared across bundled chunks. */
  globalKey: symbol;
  ttlMs: number;
  maxSize: number;
  persistent: {
    namespace: string;
    maxEntries: number;
    /** Usually `() => runtime?.state.openKeyedStore(options)`; undefined skips persistence. */
    openStore: (options: OpenKeyedStoreOptions) => PersistentDedupeStore<TRecord> | undefined;
    logError?: (error: unknown) => void;
    /** Memory re-prime timestamp after a persistent hit; defaults to now. */
    readTimestamp?: (record: TRecord) => number | undefined;
  };
}): PersistentDedupeCache<TRecord> {
  const memory = resolveGlobalDedupeCache(params.globalKey, {
    ttlMs: params.ttlMs,
    maxSize: params.maxSize,
  });
  let persistentStore: PersistentDedupeStore<TRecord> | undefined;
  let persistentStoreDisabled = false;

  const disablePersistentStore = (error: unknown) => {
    persistentStoreDisabled = true;
    persistentStore = undefined;
    params.persistent.logError?.(error);
  };

  const getPersistentStore = (): PersistentDedupeStore<TRecord> | undefined => {
    if (persistentStoreDisabled) {
      return undefined;
    }
    if (persistentStore) {
      return persistentStore;
    }
    try {
      persistentStore = params.persistent.openStore({
        namespace: params.persistent.namespace,
        maxEntries: params.persistent.maxEntries,
        defaultTtlMs: params.ttlMs,
      });
      return persistentStore;
    } catch (error) {
      disablePersistentStore(error);
      return undefined;
    }
  };

  return {
    peek: (key) => memory.peek(key),
    lookup: async (key) => {
      if (memory.peek(key)) {
        return true;
      }
      const store = getPersistentStore();
      if (!store) {
        return false;
      }
      let record: TRecord | undefined;
      try {
        record = await store.lookup(key);
      } catch (error) {
        disablePersistentStore(error);
        return false;
      }
      if (record === undefined) {
        return false;
      }
      memory.check(key, params.persistent.readTimestamp?.(record));
      return true;
    },
    register: async (key, record, opts) => {
      memory.check(key, opts?.at);
      const store = getPersistentStore();
      if (!store) {
        return;
      }
      try {
        await store.register(key, record);
      } catch (error) {
        disablePersistentStore(error);
      }
    },
    clearForTest: () => {
      memory.clear();
      persistentStore = undefined;
      persistentStoreDisabled = false;
    },
  };
}
