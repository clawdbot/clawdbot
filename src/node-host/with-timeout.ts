/** Timeout wrapper for node-host operations using AbortSignal cancellation. */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

/**
 * AbortSignal-based timeout wrapper for node-host operations.
 *
 * The wrapper races work against an abort promise, clears timers/listeners on
 * completion, and preserves object-shaped abort reasons as Error properties.
 */
/** Run work with an optional timeout and AbortSignal. */
export async function withTimeout<T>(
  work: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
  label?: string,
): Promise<T> {
  const resolved = timeoutMs === undefined ? undefined : resolveTimerTimeoutMs(timeoutMs, 1);
  if (!resolved) {
    return await work(undefined);
  }

  const abortCtrl = new AbortController();
  const timeoutError = new Error(`${label ?? "request"} timed out`);
  const timer = setTimeout(() => abortCtrl.abort(timeoutError), resolved);
  timer.unref?.();

  let abortListener: (() => void) | undefined;
  const abortPromise: Promise<never> = abortCtrl.signal.aborted
    ? Promise.reject(
        toLintErrorObject(abortCtrl.signal.reason ?? timeoutError, "Non-Error rejection"),
      )
    : new Promise((_, reject) => {
        abortListener = () =>
          reject(toLintErrorObject(abortCtrl.signal.reason ?? timeoutError, "Non-Error rejection"));
        abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
      });

  try {
    return await Promise.race([work(abortCtrl.signal), abortPromise]);
  } finally {
    clearTimeout(timer);
    if (abortListener) {
      // Remove the listener even when work wins the race to avoid retaining closures.
      abortCtrl.signal.removeEventListener("abort", abortListener);
    }
  }
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
