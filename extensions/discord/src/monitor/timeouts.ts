// Compatibility constants for existing imports. Discord no longer enforces
// channel-owned listener or inbound run timeouts.
export const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 120_000;
export const DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS = 30 * 60_000;

export const DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS = 60_000;
export const DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS = 120_000;

export function mergeAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const fallbackController = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      fallbackController.abort();
      return fallbackController.signal;
    }
  }
  const abortFallback = () => {
    fallbackController.abort();
    for (const signal of activeSignals) {
      signal.removeEventListener("abort", abortFallback);
    }
  };
  for (const signal of activeSignals) {
    signal.addEventListener("abort", abortFallback, { once: true });
  }
  return fallbackController.signal;
}

export async function raceWithTimeout<T, U>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  onTimeout: () => U;
}): Promise<T | U> {
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<U>((resolve) => {
    timeoutTimer = setTimeout(() => resolve(params.onTimeout()), Math.max(1, params.timeoutMs));
    timeoutTimer.unref?.();
  });
  try {
    return await Promise.race([params.promise, timeoutPromise]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
}

export async function withAbortTimeout<T>(params: {
  timeoutMs: number;
  createTimeoutError: () => Error;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(
      () => {
        controller.abort();
        reject(params.createTimeoutError());
      },
      Math.max(1, params.timeoutMs),
    );
    timeoutTimer.unref?.();
  });
  try {
    return await Promise.race([params.run(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
}
