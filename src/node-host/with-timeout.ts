/** Timeout wrapper for node-host operations using AbortSignal cancellation. */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { createDeferredCore } from "../shared/deferred.js";

/** A caller-owned timeout can outlive an individual awaited operation. */
export function createRetainedTimeout(timeoutMs: number, label: string | (() => string)) {
  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let currentDeadline:
    | { kind: "bounded"; deadlineAtMs: number }
    | { kind: "unlimited" }
    | undefined;
  const setDeadline = (
    deadline: { kind: "bounded"; deadlineAtMs: number } | { kind: "unlimited" },
  ) => {
    if (closed || abortController.signal.aborted) {
      return;
    }
    currentDeadline = deadline;
    clearTimeout(timer);
    if (deadline.kind === "unlimited") {
      return;
    }
    timer = setTimeout(
      () => {
        if (closed || currentDeadline !== deadline || abortController.signal.aborted) {
          return;
        }
        const operation = typeof label === "function" ? label() : label;
        abortController.abort(new Error(`${operation} timed out`));
      },
      Math.max(1, deadline.deadlineAtMs - Date.now()),
    );
    timer.unref?.();
  };
  const reset = () => setDeadline({ kind: "bounded", deadlineAtMs: Date.now() + timeoutMs });
  reset();
  return {
    signal: abortController.signal,
    setDeadline,
    reset,
    race: async <T>(work: Promise<T>): Promise<T> => {
      const aborted = createDeferredCore<never>();
      const onAbort = () => aborted.reject(abortController.signal.reason);
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      if (abortController.signal.aborted) {
        onAbort();
      }
      try {
        return await Promise.race([work, aborted.promise]);
      } finally {
        abortController.signal.removeEventListener("abort", onAbort);
      }
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}

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

  const timeout = createRetainedTimeout(resolved, label ?? "request");
  try {
    return await timeout.race(work(timeout.signal, timeout.reset));
  } finally {
    timeout.close();
  }
}
