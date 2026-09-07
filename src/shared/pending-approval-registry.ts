type PendingApprovalEntry<TValue> = {
  id: string;
  value: TValue;
  delivering: boolean;
  queued?: (entry: PendingApprovalEntry<TValue>) => void | Promise<void>;
  timeoutId?: ReturnType<typeof setTimeout>;
};

type PendingApprovalTerminal<TValue> = NonNullable<PendingApprovalEntry<TValue>["queued"]>;

export function createPendingApprovalRegistry<TValue>() {
  const pending = new Map<string, PendingApprovalEntry<TValue>>();
  let expiryStopped = false;
  const remove = (id: string, expected?: PendingApprovalEntry<TValue>) => {
    const entry = pending.get(id);
    if (!entry || (expected && entry !== expected)) {
      return undefined;
    }
    pending.delete(id);
    clearTimeout(entry.timeoutId);
    return entry;
  };
  const isCurrent = (entry: PendingApprovalEntry<TValue>) => pending.get(entry.id) === entry;
  const begin = (id: string, value: TValue) => {
    remove(id);
    const entry: PendingApprovalEntry<TValue> = { id, value, delivering: true };
    pending.set(id, entry);
    return entry;
  };
  const completeDelivery = async (entry: PendingApprovalEntry<TValue>, value: TValue) => {
    if (!isCurrent(entry)) {
      return;
    }
    entry.value = value;
    entry.delivering = false;
    if (entry.queued) {
      remove(entry.id, entry);
      await entry.queued(entry);
    }
  };
  const settle = (id: string, terminal: PendingApprovalTerminal<TValue>) => {
    const entry = pending.get(id);
    if (!entry) {
      return { status: "missing" } as const;
    }
    if (entry.delivering) {
      // First terminal event wins, but its notice waits until pending delivery finishes.
      entry.queued ??= terminal;
      return { status: "queued" } as const;
    }
    remove(id, entry);
    return { status: "taken", entry, terminal } as const;
  };
  const scheduleExpiry = (
    entry: PendingApprovalEntry<TValue>,
    timeoutMs: number,
    onExpire: PendingApprovalTerminal<TValue>,
  ) => {
    if (expiryStopped || !isCurrent(entry)) {
      return;
    }
    entry.timeoutId = setTimeout(() => {
      if (expiryStopped || !isCurrent(entry)) {
        return;
      }
      const expired = settle(entry.id, onExpire);
      if (expired.status === "taken") {
        void expired.terminal(expired.entry);
      }
    }, timeoutMs);
    entry.timeoutId.unref?.();
  };
  const clear = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeoutId);
    }
    pending.clear();
  };
  const stopExpiryTimers = () => {
    expiryStopped = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timeoutId);
    }
  };
  const has = (id: string) => pending.has(id);
  return {
    has,
    begin,
    isCurrent,
    completeDelivery,
    settle,
    scheduleExpiry,
    remove,
    clear,
    stopExpiryTimers,
  };
}
