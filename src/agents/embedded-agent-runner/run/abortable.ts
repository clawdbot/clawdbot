/**
 * AbortSignal-aware promise racing helper for embedded-agent attempts.
 */
function getAbortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

function makeAbortError(signal: AbortSignal): Error {
  const reason = getAbortReason(signal);
  if (reason instanceof Error) {
    const err = new Error(reason.message, { cause: reason });
    err.name = "AbortError";
    return err;
  }
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Races a promise against an AbortSignal while preserving normal promise
 * settlement. Abort wins immediately and rejected non-Error payloads are
 * normalized so callers can safely log/inspect them as Error objects.
 */
export function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(makeAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(makeAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(toLintErrorObject(err, "Non-Error rejection"));
      },
    );
  });
}

/** Converts non-Error promise rejections into Error instances without dropping object fields. */
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
