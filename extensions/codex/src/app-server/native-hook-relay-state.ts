type PendingUnregister = {
  timeout: ReturnType<typeof setTimeout>;
  unregister: () => void;
};

const pending = new Set<PendingUnregister>();

/** Owns delayed hook-relay cleanup across runtime scheduling and test teardown. */
export const nativeHookRelayUnregisterQueue = {
  add(entry: PendingUnregister): void {
    pending.add(entry);
  },
  delete(entry: PendingUnregister): boolean {
    return pending.delete(entry);
  },
  flush(): void {
    while (pending.size > 0) {
      const entry = pending.values().next().value;
      if (!entry) {
        return;
      }
      clearTimeout(entry.timeout);
      entry.unregister();
    }
  },
  clear(): void {
    for (const entry of pending) {
      clearTimeout(entry.timeout);
    }
    pending.clear();
  },
};
