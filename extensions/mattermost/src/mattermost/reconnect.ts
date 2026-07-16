export type ReconnectOutcome = "resolved" | "rejected";

export type ShouldReconnectParams = {
  attempt: number;
  delayMs: number;
  outcome: ReconnectOutcome;
  error?: unknown;
};

export type RunWithReconnectOpts = {
  abortSignal?: AbortSignal;
  onError?: (err: unknown) => void;
  onReconnect?: (delayMs: number) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  shouldReconnect?: (params: ShouldReconnectParams) => boolean;
};

/**
 * Reconnection loop with exponential backoff.
 *
 * Calls `connectFn` in a while loop. On normal resolve (connection closed),
 * the backoff resets. On thrown error (connection failed), the current delay is
 * used, then doubled for the next retry.
 * The loop exits when `abortSignal` fires.
 */
export async function runWithReconnect(
  connectFn: () => Promise<void>,
  opts: RunWithReconnectOpts = {},
): Promise<void> {
  const { initialDelayMs = 2000, maxDelayMs = 60_000 } = opts;
  const jitterRatio = Math.max(0, opts.jitterRatio ?? 0);
  const random = opts.random ?? Math.random;
  let retryDelay = initialDelayMs;
  let attempt = 0;

  while (!opts.abortSignal?.aborted) {
    let shouldIncreaseDelay = false;
    let outcome: ReconnectOutcome = "resolved";
    let error: unknown;
    try {
      await connectFn();
      retryDelay = initialDelayMs;
    } catch (err) {
      if (opts.abortSignal?.aborted) {
        return;
      }
      outcome = "rejected";
      error = err;
      opts.onError?.(err);
      shouldIncreaseDelay = true;
    }
    if (opts.abortSignal?.aborted) {
      return;
    }
    const delayMs = withJitter(retryDelay, jitterRatio, random);
    const shouldReconnect =
      opts.shouldReconnect?.({
        attempt,
        delayMs,
        outcome,
        error,
      }) ?? true;
    if (!shouldReconnect) {
      return;
    }
    opts.onReconnect?.(delayMs);
    await sleepAbortable(delayMs, opts.abortSignal);
    if (shouldIncreaseDelay) {
      retryDelay = Math.min(retryDelay * 2, maxDelayMs);
    }
    attempt++;
  }
}

function withJitter(baseMs: number, jitterRatio: number, random: () => number): number {
  if (jitterRatio <= 0) {
    return baseMs;
  }
  const normalized = Math.max(0, Math.min(1, random()));
  const spread = baseMs * jitterRatio;
  return Math.max(1, Math.round(baseMs - spread + normalized * spread * 2));
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
