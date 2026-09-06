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

// Post-turn joins (pending subscription handlers, block-reply flush) ride
// delivery chains that can wedge; the default run budget is 48h, so an
// unbounded await there dead-ends the turn with no visible outcome. 120s
// matches the cloud llm-idle class: anything quiet longer is a stuck lane,
// not legitimate delivery work.
export const RUN_LIVENESS_JOIN_TIMEOUT_MS = 120_000;

/**
 * Awaits post-turn work that must never dead-end the run: races the joined
 * promise against the run-abort signal and a liveness deadline. Timeout and
 * abort RESOLVE (timeout after `onTimeout`) instead of rejecting so settlement
 * still produces a visible terminal outcome; rejections also resolve because
 * the joined chains own their error logging.
 */
export function joinWithRunLivenessDeadline(input: {
  joinWork: () => Promise<void> | void;
  runAbortSignal?: AbortSignal;
  timeoutMs?: number;
  onTimeout: () => void;
}): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (reason: "settled" | "timeout" | "abort") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.runAbortSignal?.removeEventListener("abort", onAbort);
      if (reason === "timeout") {
        input.onTimeout();
      }
      resolve();
    };
    const onAbort = () => finish("abort");
    const timer = setTimeout(
      () => finish("timeout"),
      input.timeoutMs ?? RUN_LIVENESS_JOIN_TIMEOUT_MS,
    );
    timer.unref?.();
    if (input.runAbortSignal?.aborted) {
      finish("abort");
      return;
    }
    input.runAbortSignal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => input.joinWork())
      .then(
        () => finish("settled"),
        () => finish("settled"),
      );
  });
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
