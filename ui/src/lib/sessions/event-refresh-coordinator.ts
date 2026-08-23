const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;
const SESSION_EVENT_REFRESH_MAX_WAIT_MS = 1_000;

type SessionEventRefreshCoordinatorOptions = {
  canRefresh: () => boolean;
  refresh: () => Promise<void>;
};

/** Canonical bounded event refresh policy shared by session-list owners. */
export function createSessionEventRefreshCoordinator(
  options: SessionEventRefreshCoordinatorOptions,
) {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let deadline: number | null = null;
  let inFlight: Promise<void> | null = null;
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
    if (disposed || !options.canRefresh()) {
      return;
    }
    if (inFlight) {
      trailing = true;
      return;
    }
    const operationGeneration = generation;
    const operation = options.refresh().catch(() => undefined);
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

  return {
    schedule() {
      if (disposed || !options.canRefresh()) {
        return;
      }
      const now = Date.now();
      deadline ??= now + SESSION_EVENT_REFRESH_MAX_WAIT_MS;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
      }
      const delay = Math.min(SESSION_EVENT_REFRESH_DEBOUNCE_MS, Math.max(0, deadline - now));
      timer = globalThis.setTimeout(() => {
        timer = null;
        deadline = null;
        start();
      }, delay);
    },
    flush() {
      if (timer === null) {
        return;
      }
      clearTimer();
      start();
    },
    absorb() {
      clearTimer();
      trailing = false;
    },
    reset() {
      clearTimer();
      trailing = false;
      inFlight = null;
      generation += 1;
    },
    dispose() {
      clearTimer();
      trailing = false;
      inFlight = null;
      generation += 1;
      disposed = true;
    },
  };
}
