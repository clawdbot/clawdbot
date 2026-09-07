/** Timeout wrapper for node-host operations using AbortSignal cancellation. */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { createDeferredCore } from "../shared/deferred.js";

/** Run bounded work; dynamic labels identify the stage pending at the deadline. */
export async function runAbortableTimeout<T>(
  work: (signal: AbortSignal | undefined, resetTimeout: () => void) => Promise<T>,
  timeoutMs?: number,
  label?: string | (() => string),
): Promise<T> {
  const resolved = timeoutMs === undefined ? undefined : resolveTimerTimeoutMs(timeoutMs, 1);
  if (!resolved) {
    return await work(undefined, () => {});
  }

  const abortCtrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const resetTimeout = () => {
    if (settled || abortCtrl.signal.aborted) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const operation = typeof label === "function" ? label() : (label ?? "request");
      abortCtrl.abort(new Error(`${operation} timed out`));
    }, resolved);
    timer.unref?.();
  };
  resetTimeout();

  const aborted = createDeferredCore<never>();
  const abortListener = () => aborted.reject(abortCtrl.signal.reason);
  abortCtrl.signal.addEventListener("abort", abortListener, { once: true });

  try {
    return await Promise.race([work(abortCtrl.signal, resetTimeout), aborted.promise]);
  } finally {
    settled = true;
    clearTimeout(timer);
    // Work may finish first; its signal must not retain the pending rejection.
    abortCtrl.signal.removeEventListener("abort", abortListener);
  }
}
