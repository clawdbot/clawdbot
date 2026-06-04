/** Per-scope TTL cache used to suppress repeated ids without cross-scope bleed. */
export type ScopedExpiringIdCache<TScope extends string | number, TId extends string | number> = {
  /** Records an id for a scope at the provided timestamp or current time. */
  record: (scope: TScope, id: TId, now?: number) => void;
  /** Returns true while the id is present and within the inclusive TTL window. */
  has: (scope: TScope, id: TId, now?: number) => boolean;
  /** Clears every scope and id from the backing store. */
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
  /** Backing store supplied by callers that need module- or test-owned lifecycle. */
  store: Map<string, Map<string, number>>;
  /** Time-to-live in milliseconds; non-finite values collapse to immediate expiry. */
  ttlMs: number;
  /** Scope size that triggers opportunistic cleanup on record. */
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
