export type DeferredMaintenanceWriteFence = {
  run: <T>(operation: () => Promise<T>) => Promise<T>;
  close: (reason: Error) => Promise<void>;
};

// Closing rejects late rewrites and drains already-admitted host transcript writes
// before fallback maintenance or foreground reads can enter the session.
export function createDeferredMaintenanceWriteFence(): DeferredMaintenanceWriteFence {
  let closedReason: Error | undefined;
  let activeWrites = 0;
  let resolveDrain: (() => void) | undefined;
  let drain = Promise.resolve();
  return {
    run: async <T>(operation: () => Promise<T>) => {
      if (closedReason) {
        throw closedReason;
      }
      if (activeWrites++ === 0) {
        drain = new Promise<void>((resolve) => {
          resolveDrain = resolve;
        });
      }
      try {
        return await operation();
      } finally {
        activeWrites -= 1;
        if (activeWrites === 0) {
          resolveDrain?.();
          resolveDrain = undefined;
        }
      }
    },
    close: async (reason) => {
      closedReason ??= reason;
      await drain;
    },
  };
}
