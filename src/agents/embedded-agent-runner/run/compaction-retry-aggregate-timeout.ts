/**
 * Caps compaction retry waits against the aggregate run timeout.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

/**
 * Waits for compaction retry completion with an aggregate timeout so a lost
 * retry resolution cannot hold the session lane indefinitely.
 */
export async function waitForCompactionRetryWithAggregateTimeout(params: {
  waitForCompactionRetry: () => Promise<void>;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  aggregateTimeoutMs: number;
  onTimeout?: () => void;
  isCompactionStillInFlight?: () => boolean;
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

      // Keep extending the timeout window while compaction is actively running.
      // We only trigger the fallback timeout once compaction appears idle.
      if (params.isCompactionStillInFlight?.()) {
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
