import { sleepWithAbort } from "@openclaw/retry";
/**
 * Sleep helper that respects abort signal.
 */
import { createAbortError } from "../../infra/abort-signal.js";
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Cancellation wins even for zero-delay waits so aborted runs cannot
  // advance into follow-on work such as computer-tool screenshot capture.
  if (signal?.aborted) {
    return Promise.reject(
      createAbortError("aborted", { cause: signal.reason ?? new Error("aborted") }),
    );
  }
  return sleepWithAbort(resolveTimerTimeoutMs(ms, 0, 0), signal);
}
