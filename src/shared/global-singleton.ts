/**
 * Process-local singleton helpers for registries, caches, and SDK-visible shared state.
 * Keys must be symbols so unrelated modules cannot collide on `globalThis` property names.
 */
const GLOBAL_SINGLETON_RESETS_KEY = Symbol.for("openclaw.globalSingletonLifecycleResets");

type GlobalSingletonLifecycle = "close-and-restart" | "close-only" | "plugin-registry";
type GlobalSingletonReset<T> = (value: T) => void | Promise<void>;
type RegisteredGlobalSingletonReset = {
  lifecycle: GlobalSingletonLifecycle;
  reset: () => void | Promise<void>;
};

function resolveGlobalSingletonResetRegistry(): Map<symbol, RegisteredGlobalSingletonReset> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[GLOBAL_SINGLETON_RESETS_KEY];
  if (existing instanceof Map) {
    return existing as Map<symbol, RegisteredGlobalSingletonReset>;
  }
  const created = new Map<symbol, RegisteredGlobalSingletonReset>();
  globalStore[GLOBAL_SINGLETON_RESETS_KEY] = created;
  return created;
}

/** Resolves a process-local singleton for caches and registries that tolerate helper lookup. */
export function resolveGlobalSingleton<T>(
  key: symbol,
  create: () => T,
  reset?: GlobalSingletonReset<T>,
  lifecycle: GlobalSingletonLifecycle = "close-and-restart",
): T {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  let value: T;
  if (Object.hasOwn(globalStore, key)) {
    value = globalStore[key] as T;
  } else {
    value = create();
    globalStore[key] = value;
  }
  if (reset) {
    // Rent: duplicated runtime chunks share both the slot and its lifecycle owner.
    // Keep the callback registered across restarts and reset the shared value in place.
    resolveGlobalSingletonResetRegistry().set(key, {
      lifecycle,
      reset: () => reset(value),
    });
  }
  return value;
}

/** Resolves a process-local Map singleton for keyed caches backed by globalThis. */
export function resolveGlobalMap<TKey, TValue>(
  key: symbol,
  reset?: GlobalSingletonLifecycle | GlobalSingletonReset<Map<TKey, TValue>>,
  lifecycle?: GlobalSingletonLifecycle,
): Map<TKey, TValue> {
  return typeof reset === "string"
    ? resolveGlobalSingleton(
        key,
        () => new Map<TKey, TValue>(),
        (value) => value.clear(),
        reset,
      )
    : resolveGlobalSingleton(key, () => new Map<TKey, TValue>(), reset, lifecycle);
}

/** Resolves a lifecycle-owned process-local Set singleton. */
export function resolveGlobalSet<T>(key: symbol, lifecycle: GlobalSingletonLifecycle): Set<T> {
  return resolveGlobalSingleton(
    key,
    () => new Set<T>(),
    (value) => value.clear(),
    lifecycle,
  );
}

/** Resets every opt-in singleton while preserving shared object identity for the next lifecycle. */
export async function drainGlobalSingletonLifecycleState(
  event: "close" | "plugin-registry" | "restart" = "close",
): Promise<void> {
  const resets = [...resolveGlobalSingletonResetRegistry().values()]
    .filter(({ lifecycle }) => {
      if (event === "plugin-registry") {
        return lifecycle === "plugin-registry";
      }
      if (lifecycle === "plugin-registry") {
        return false;
      }
      return event === "close" || lifecycle === "close-and-restart";
    })
    .map(({ reset }) => {
      try {
        return Promise.resolve(reset());
      } catch (error) {
        return Promise.reject(
          error instanceof Error
            ? error
            : new Error("Global singleton reset failed", { cause: error }),
        );
      }
    });
  const settled = await Promise.allSettled(resets);
  const errors = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to reset global singleton lifecycle state");
  }
}
