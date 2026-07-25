/**
 * AbortSignal-aware promise racing helper for embedded-agent attempts.
 */
import { toErrorObject } from "../../../infra/errors.js";

function getAbortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

/** Marks AbortErrors produced by abortable() so provider aborts stay retryable. */
const OPENCLAW_ABORTABLE_WRAPPER = Symbol.for("openclaw.abortable.wrapper");

export function isOpenClawAbortableWrapper(err: unknown): boolean {
  return err !== null && typeof err === "object" && OPENCLAW_ABORTABLE_WRAPPER in err;
}

function tagAsAbortableWrapper(err: Error): Error {
  (err as Error & { [OPENCLAW_ABORTABLE_WRAPPER]?: true })[OPENCLAW_ABORTABLE_WRAPPER] = true;
  return err;
}

function makeAbortError(signal: AbortSignal): Error {
  const reason = getAbortReason(signal);
  if (reason instanceof Error) {
    const err = new Error(reason.message, { cause: reason });
    err.name = "AbortError";
    return tagAsAbortableWrapper(err);
  }
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return tagAsAbortableWrapper(err);
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
        reject(toErrorObject(err, "Non-Error rejection"));
      },
    );
  });
}
