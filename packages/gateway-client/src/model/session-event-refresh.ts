const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_WAIT_MS = 1_000;

export type SessionEventRefreshCoordinatorOptions = Readonly<{
  active: boolean;
  refresh: () => Promise<void>;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}>;

/**
 * Canonical bounded event-refresh policy shared by Control Model and Control UI.
 * Hidden owners defer work; one in-flight refresh may acquire one trailing run.
 */
export function createSessionEventRefreshCoordinator({
  active: initialActive,
  refresh,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
}: SessionEventRefreshCoordinatorOptions) {
  let active = initialActive;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let deadline: number | null = null;
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let trailing = false;
  let generation = 0;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    deadline = null;
  };

  const start = () => {
    clearTimer();
    if (disposed) {
      return;
    }
    if (!active) {
      queued = true;
      return;
    }
    if (inFlight) {
      trailing = true;
      return;
    }
    queued = false;
    const operationGeneration = generation;
    let operation: Promise<void>;
    try {
      operation = refresh();
    } catch {
      operation = Promise.resolve();
    }
    operation = operation.catch(() => undefined);
    const pending = operation.finally(() => {
      if (generation !== operationGeneration || inFlight !== pending) {
        return;
      }
      inFlight = null;
      if (trailing) {
        trailing = false;
        start();
      }
    });
    inFlight = pending;
  };

  const absorb = () => {
    clearTimer();
    queued = false;
    trailing = false;
  };

  return {
    schedule() {
      if (disposed) {
        return;
      }
      if (!active) {
        clearTimer();
        queued = true;
        return;
      }
      const currentTime = now();
      deadline ??= currentTime + maxWaitMs;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
      }
      const delay = Math.min(debounceMs, Math.max(0, deadline - currentTime));
      timer = globalThis.setTimeout(start, delay);
    },
    flush() {
      if (timer === null) {
        return;
      }
      start();
    },
    setActive(next: boolean, markDirty = false) {
      active = next;
      if (next) {
        if (queued) {
          start();
        }
        return;
      }
      queued ||= markDirty || timer !== null || inFlight !== null;
      trailing = false;
      clearTimer();
    },
    absorb,
    reset() {
      absorb();
      inFlight = null;
      generation += 1;
    },
    dispose() {
      absorb();
      inFlight = null;
      generation += 1;
      disposed = true;
    },
  };
}
