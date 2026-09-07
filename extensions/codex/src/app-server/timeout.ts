/**
 * Thin Codex app-server timeout adapter around OpenClaw's shared timeout helper.
 */
import { withTimeout as withSharedTimeout } from "openclaw/plugin-sdk/time-runtime";

function resolveAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex app-server operation aborted", { cause: signal.reason });
}

/** Awaits a promise with a Codex-specific timeout error message. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  createError?: () => Error,
): Promise<T> {
  return await withSharedTimeout(promise, timeoutMs, {
    message: timeoutMessage,
    ...(createError ? { createError } : {}),
  });
}

/** Bounds an operation by both its owner lifecycle and one total wall-clock budget. */
export async function withAbortableTimeout<T>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutMessage: string;
  createTimeoutError?: () => Error;
}): Promise<T> {
  const signal = params.signal;
  if (signal?.aborted) {
    throw resolveAbortError(signal);
  }
  let removeAbortListener: (() => void) | undefined;
  const operation = signal
    ? Promise.race([
        params.promise,
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(resolveAbortError(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }),
      ])
    : params.promise;
  try {
    return await withTimeout(
      operation,
      params.timeoutMs,
      params.timeoutMessage,
      params.createTimeoutError,
    );
  } finally {
    removeAbortListener?.();
  }
}
