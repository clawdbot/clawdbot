const MAX_DISCORD_TIMEOUT_MS = 2_147_483_647;

export const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 120_000;
export const DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS = 30 * 60_000;
export const DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS = 60_000;
export const DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS = 120_000;

function clampDiscordTimeoutMs(timeoutMs: number, minimumMs: number): number {
  return Math.max(minimumMs, Math.min(Math.floor(timeoutMs), MAX_DISCORD_TIMEOUT_MS));
}

export function normalizeDiscordListenerTimeoutMs(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw ?? 0) <= 0) {
    return DISCORD_DEFAULT_LISTENER_TIMEOUT_MS;
  }
  return clampDiscordTimeoutMs(raw!, 1_000);
}

export function normalizeDiscordInboundWorkerTimeoutMs(
  raw: number | undefined,
): number | undefined {
  if (raw === 0) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS;
  }
  return clampDiscordTimeoutMs(raw, 1);
}

export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return "name" in error && String((error as { name?: unknown }).name) === "AbortError";
}

export function mergeAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const fallbackController = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      fallbackController.abort();
      return fallbackController.signal;
    }
  }
  const abortFallback = () => {
    fallbackController.abort();
    for (const signal of activeSignals) {
      signal.removeEventListener("abort", abortFallback);
    }
  };
  for (const signal of activeSignals) {
    signal.addEventListener("abort", abortFallback, { once: true });
  }
  return fallbackController.signal;
}

export async function runDiscordTaskWithTimeout(params: {
  run: (abortSignal: AbortSignal | undefined) => Promise<void>;
  timeoutMs?: number;
  abortSignals?: Array<AbortSignal | undefined>;
  onTimeout: (timeoutMs: number) => void | Promise<void>;
  onAbortAfterTimeout?: () => void;
  onErrorAfterTimeout?: (error: unknown) => void;
}): Promise<boolean> {
  const timeoutAbortController = params.timeoutMs ? new AbortController() : undefined;
  const mergedAbortSignal = mergeAbortSignals([
    ...(params.abortSignals ?? []),
    timeoutAbortController?.signal,
  ]);

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const runPromise = params.run(mergedAbortSignal).catch((error) => {
    if (!timedOut) {
      throw error;
    }
    if (timeoutAbortController?.signal.aborted && isAbortError(error)) {
      params.onAbortAfterTimeout?.();
      return;
    }
    params.onErrorAfterTimeout?.(error);
  });

  try {
    if (!params.timeoutMs) {
      await runPromise;
      return false;
    }
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), params.timeoutMs);
      timeoutHandle.unref?.();
    });
    const result = await Promise.race([
      runPromise.then(() => "completed" as const),
      timeoutPromise,
    ]);
    if (result === "timeout") {
      timedOut = true;
      timeoutAbortController?.abort();
      await params.onTimeout(params.timeoutMs);
      return true;
    }
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
