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
