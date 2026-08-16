import { CONTROL_MODEL_SESSION_REFRESH_DEFAULTS } from "./defaults.js";

export type SessionEventRefreshCoordinatorOptions = Readonly<{
  canRefresh: () => boolean;
  refresh: () => Promise<void>;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
}>;

/**
 * Canonical bounded event-refresh policy shared by Control Model and Control UI.
 * One in-flight refresh may acquire one trailing run, including after failure.
 */
export function createSessionEventRefreshCoordinator(
  options: SessionEventRefreshCoordinatorOptions,
) {
  const debounceMs = options.debounceMs ?? CONTROL_MODEL_SESSION_REFRESH_DEFAULTS.debounceMs;
  const maxWaitMs = options.maxWaitMs ?? CONTROL_MODEL_SESSION_REFRESH_DEFAULTS.maxWaitMs;
  const now = options.now ?? Date.now;
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
      const currentTime = now();
      deadline ??= currentTime + maxWaitMs;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
      }
      const delay = Math.min(debounceMs, Math.max(0, deadline - currentTime));
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
