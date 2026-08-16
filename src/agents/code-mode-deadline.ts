/** Race preparation and bridge work against the same guest-owned deadline. */
export async function awaitCodeModeDeadline<T>(params: {
  operation: () => Promise<T>;
  deadlineMs: number;
  signal?: AbortSignal;
  createTimeoutError: () => Error;
  createAbortError: (signal: AbortSignal) => Error;
}): Promise<T> {
  const remainingMs = params.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw params.createTimeoutError();
  }
  if (params.signal?.aborted) {
    throw params.createAbortError(params.signal);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(params.createTimeoutError()), remainingMs);
      const signal = params.signal;
      if (signal) {
        onAbort = () => reject(params.createAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }
    });
    return await Promise.race([params.operation(), deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (params.signal && onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}
