/**
 * Caps compaction retry waits against the aggregate run timeout.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

export function hasActiveCompactionRetryWork(params: {
  isCompactionInFlight: boolean;
  isSessionStreaming: boolean;
}): boolean {
  return params.isCompactionInFlight || params.isSessionStreaming;
}

/**
 * Waits for compaction retry completion with an aggregate timeout so a lost
 * retry resolution cannot hold the session lane indefinitely.
 */
export async function waitForCompactionRetryWithAggregateTimeout(params: {
  waitForCompactionRetry: () => Promise<void>;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  aggregateTimeoutMs: number;
  /** Called once when the wait gives up after compaction is no longer active. */
  onTimeout?: () => void;
  /** Keeps extending the timeout while compaction or its retry is still active. */
  isCompactionRetryStillActive?: () => boolean;
}): Promise<{ timedOut: boolean }> {
  const timeoutMs = resolveTimerTimeoutMs(params.aggregateTimeoutMs, 1);

  let timedOut = false;
  // Reflect the retry promise so late rejections after a timeout stay handled
  // without masking failures that settle before the timeout path wins.
  const waitPromise = params.waitForCompactionRetry().then(
    () => ({ kind: "done" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await params.abortable(
        Promise.race([
          waitPromise,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
          }),
        ]),
      );

      if (result !== "timeout") {
        if (result.kind === "done") {
          break;
        }
        throw result.error;
      }

      // A post-compaction retry is a normal model run, so compaction itself is
      // already idle while the provider request is still active. Only start
      // deadlock recovery after both phases are idle.
      if (params.isCompactionRetryStillActive?.()) {
        continue;
      }

      timedOut = true;
      params.onTimeout?.();
      break;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return { timedOut };
}
