export function createAbortError(message: string, options?: ErrorOptions): Error {
  const error = new Error(message, options);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  if (name === "AbortError") {
    return true;
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return message === "This operation was aborted";
}

export function mergeAbortSignals(signals: ReadonlyArray<AbortSignal | undefined>): {
  signal?: AbortSignal;
  dispose: () => void;
} {
  const activeSignals: AbortSignal[] = [];
  for (const signal of signals) {
    if (signal && !activeSignals.includes(signal)) {
      activeSignals.push(signal);
    }
  }
  if (activeSignals.length <= 1) {
    return { signal: activeSignals[0], dispose: () => {} };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.clear();
  };
  const abortFrom = (signal: AbortSignal) => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(signal.reason);
    dispose();
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener("abort", listener, { once: true });
    if (controller.signal.aborted || signal.aborted) {
      if (!controller.signal.aborted) {
        abortFrom(signal);
      }
      break;
    }
  }

  return { signal: controller.signal, dispose };
}

/** Resolves when the signal aborts, or immediately when no wait is needed. */
export async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      // Remove explicitly even with `{ once: true }`; tests use foreign
      // AbortSignal-like objects, and cleanup must stay deterministic there.
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
