const terminalPersistenceErrorByEntry = new WeakMap<object, unknown>();
const removalWaitersByEntry = new WeakMap<object, Set<() => void>>();

export function markChatAbortTerminalPersistenceError(entry: object, error: unknown): void {
  if (error === undefined) {
    terminalPersistenceErrorByEntry.delete(entry);
    return;
  }
  terminalPersistenceErrorByEntry.set(entry, error);
}

export function notifyChatAbortControllerRemoved(entry: object): void {
  const waiters = removalWaitersByEntry.get(entry);
  removalWaitersByEntry.delete(entry);
  for (const resolve of waiters ?? []) {
    resolve();
  }
}

/** Waits for captured run registrations and their terminal persistence owner to leave. */
export async function waitForChatAbortControllerRemoval<
  TEntry extends {
    projectSessionTerminalPending?: boolean;
    projectSessionTerminalPersistence?: Promise<void>;
  },
>(params: {
  entries: ReadonlyMap<string, TEntry>;
  targets: ReadonlyArray<{ runId: string; entry: TEntry }>;
  timeoutMs: number;
}): Promise<boolean> {
  const terminalOwnersSettled = () =>
    params.targets.every(
      ({ entry }) =>
        entry.projectSessionTerminalPending !== true &&
        entry.projectSessionTerminalPersistence === undefined &&
        !terminalPersistenceErrorByEntry.has(entry),
    );
  const registeredWaiters: Array<{ entry: TEntry; resolve: () => void }> = [];
  const removals = params.targets.flatMap(({ runId, entry }) => {
    if (params.entries.get(runId) !== entry) {
      return [];
    }
    return [
      new Promise<void>((resolve) => {
        const waiters = removalWaitersByEntry.get(entry) ?? new Set<() => void>();
        waiters.add(resolve);
        removalWaitersByEntry.set(entry, waiters);
        registeredWaiters.push({ entry, resolve });
      }),
    ];
  });
  if (removals.length === 0) {
    return terminalOwnersSettled();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const removed = await Promise.race([
      Promise.all(removals).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, params.timeoutMs));
        timer.unref?.();
      }),
    ]);
    // Maintenance may retire a registration before its write settles. Registry
    // removal alone must not let a lifecycle mutation bypass that terminal owner.
    return removed && terminalOwnersSettled();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    for (const { entry, resolve } of registeredWaiters) {
      const waiters = removalWaitersByEntry.get(entry);
      waiters?.delete(resolve);
      if (waiters?.size === 0) {
        removalWaitersByEntry.delete(entry);
      }
    }
  }
}
