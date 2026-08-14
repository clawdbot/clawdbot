const COMPLETION_HANDOFF_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const COMPLETION_HANDOFF_TIMEOUT_MS = 120_000;

export type MediaGenerationCompletionWakeOutcome =
  | { status: "delivered" }
  | { status: "pending" }
  | { status: "permanent_failure" };

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export async function wakeMediaGenerationTaskCompletionWithRetry(params: {
  wake: () => Promise<MediaGenerationCompletionWakeOutcome>;
  beforeRetry?: () => void;
}): Promise<MediaGenerationCompletionWakeOutcome> {
  const deadline = Date.now() + COMPLETION_HANDOFF_TIMEOUT_MS;
  let outcome = await params.wake();
  let retryIndex = 0;
  while (outcome.status === "pending") {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("cron continuation did not become ready before the handoff deadline");
    }
    const delayMs =
      COMPLETION_HANDOFF_RETRY_DELAYS_MS[
        Math.min(retryIndex, COMPLETION_HANDOFF_RETRY_DELAYS_MS.length - 1)
      ] ?? 2_000;
    await waitForRetry(Math.min(delayMs, remainingMs));
    params.beforeRetry?.();
    outcome = await params.wake();
    retryIndex += 1;
  }
  return outcome;
}
