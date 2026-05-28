export function createSessionManagerRuntimeRegistry<TValue>() {
  // Session-scoped runtime registry keyed by object identity.
  // The SessionManager instance must stay stable across set/get calls.
  const registry = new WeakMap<object, TValue>();

  const set = (sessionManager: unknown, value: TValue | null): void => {
    if (!sessionManager || typeof sessionManager !== "object") {
      return;
    }

    const key = sessionManager;
    if (value === null) {
      registry.delete(key);
      return;
    }

    registry.set(key, value);
  };

  const get = (sessionManager: unknown): TValue | null => {
    if (!sessionManager || typeof sessionManager !== "object") {
      return null;
    }

    return registry.get(sessionManager) ?? null;
  };

  return { set, get };
}
