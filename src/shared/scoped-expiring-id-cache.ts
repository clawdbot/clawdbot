export type ScopedExpiringIdCache<TScope extends string | number, TId extends string | number> = {
  record: (scope: TScope, id: TId, now?: number) => void;
  has: (scope: TScope, id: TId, now?: number) => boolean;
  clear: () => void;
};

function resolveNonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/** Creates a scoped TTL cache for ids that should expire independently per scope. */
export function createScopedExpiringIdCache<
  TScope extends string | number,
  TId extends string | number,
>(options: {
  store: Map<string, Map<string, number>>;
  ttlMs: number;
  cleanupThreshold: number;
}): ScopedExpiringIdCache<TScope, TId> {
  const ttlMs = resolveNonNegativeInteger(options.ttlMs, 0);
  const cleanupThreshold = Math.max(1, resolveNonNegativeInteger(options.cleanupThreshold, 1));

  function cleanupExpired(scopeKey: string, entry: Map<string, number>, now: number): void {
    for (const [id, timestamp] of entry) {
      // Equality stays live so callers can treat ttlMs as an inclusive age limit.
      if (now - timestamp > ttlMs) {
        entry.delete(id);
      }
    }
    if (entry.size === 0) {
      options.store.delete(scopeKey);
    }
  }

  return {
    record: (scope, id, now = Date.now()) => {
      const scopeKey = String(scope);
      const idKey = String(id);
      let entry = options.store.get(scopeKey);
      if (!entry) {
        entry = new Map<string, number>();
        options.store.set(scopeKey, entry);
      }
      entry.set(idKey, now);
      if (entry.size > cleanupThreshold) {
        // Avoid per-record scans until a scope grows past the caller's expected steady state.
        cleanupExpired(scopeKey, entry, now);
      }
    },
    has: (scope, id, now = Date.now()) => {
      const scopeKey = String(scope);
      const idKey = String(id);
      const entry = options.store.get(scopeKey);
      if (!entry) {
        return false;
      }
      cleanupExpired(scopeKey, entry, now);
      return entry.has(idKey);
    },
    clear: () => {
      options.store.clear();
    },
  };
}
