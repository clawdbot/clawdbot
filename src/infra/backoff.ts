// Computes bounded backoff delays and abortable sleeps.
import { clampPositiveTimerTimeoutMs } from "../shared/number-coercion.js";

/** Exponential backoff settings for retry loops that need bounded jitter. */
export type BackoffPolicy = {
  /** Delay in milliseconds for attempt 1 and any lower attempt value. */
  initialMs: number;
  /** Hard upper bound in milliseconds after exponential growth and jitter. */
  maxMs: number;
  /** Multiplier applied once per retry attempt after the first. */
  factor: number;
  /** Fraction of the current base delay used as additive random jitter. */
  jitter: number;
};

/** Computes a bounded exponential delay for a 1-based retry attempt. */
export function computeBackoff(policy: BackoffPolicy, attempt: number) {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

/** Sleeps for a clamped timer duration and rejects with a stable aborted error on abort. */
export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal) {
  const delayMs = clampPositiveTimerTimeoutMs(ms);
  if (delayMs === undefined) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      reject(new Error("aborted", { cause: abortSignal?.reason ?? new Error("aborted") }));
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
    }

    timer = setTimeout(() => {
      settled = true;
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      timer = null;
      resolve();
    }, delayMs);

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      }
    }
  });
}
