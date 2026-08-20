const GATEWAY_RETRY_INITIAL_DELAY_MS = 30_000;
const GATEWAY_RETRY_MAX_DELAY_MS = 5 * 60_000;

/** Owns one reconnect-safe retry timer and its bounded exponential backoff. */
export function createGatewayRetryOwner() {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let nextDelayMs = GATEWAY_RETRY_INITIAL_DELAY_MS;

  const cancel = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };

  return {
    cancel,
    reset() {
      cancel();
      nextDelayMs = GATEWAY_RETRY_INITIAL_DELAY_MS;
    },
    schedule(retry: () => void) {
      cancel();
      const delayMs = nextDelayMs;
      nextDelayMs = Math.min(nextDelayMs * 2, GATEWAY_RETRY_MAX_DELAY_MS);
      timer = globalThis.setTimeout(() => {
        timer = null;
        retry();
      }, delayMs);
    },
  };
}
