// Discord plugin module implements timeouts behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

// Compatibility constants for existing imports. Discord no longer enforces
// channel-owned listener or inbound run timeouts.
export const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 120_000;
export const DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS = 30 * 60_000;

export const DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS = 60_000;
export const DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS = 120_000;

/** @deprecated Discord listener timeouts are compatibility-only. */
export function normalizeDiscordListenerTimeoutMs(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw ?? 0) <= 0) {
    return DISCORD_DEFAULT_LISTENER_TIMEOUT_MS;
  }
  return resolveTimerTimeoutMs(raw, DISCORD_DEFAULT_LISTENER_TIMEOUT_MS, 1_000);
}

/** @deprecated Discord no longer applies channel-owned inbound run timeouts. */
export function normalizeDiscordInboundWorkerTimeoutMs(
  raw: number | undefined,
): number | undefined {
  if (raw === 0) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS;
  }
  return resolveTimerTimeoutMs(raw, DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS, 1);
}

/** @deprecated Compatibility helper for old Discord timeout integrations. */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return "name" in error && String((error as { name?: unknown }).name) === "AbortError";
}

/** @deprecated Discord no longer uses this for channel-owned message run timeouts. */
export async function runDiscordTaskWithTimeout(params: {
  run: (abortSignal: AbortSignal | undefined) => Promise<void>;
  timeoutMs?: number;
  abortSignals?: Array<AbortSignal | undefined>;
  onTimeout: (timeoutMs: number) => void | Promise<void>;
  onAbortAfterTimeout?: () => void;
  onErrorAfterTimeout?: (error: unknown) => void;
}): Promise<boolean> {
  const timeoutMs =
    params.timeoutMs === undefined ? undefined : resolveTimerTimeoutMs(params.timeoutMs, 0, 0);
  const timeoutAbortController = timeoutMs ? new AbortController() : undefined;
  const abortSignals = [...(params.abortSignals ?? []), timeoutAbortController?.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  const mergedAbortSignal =
    abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0];
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const runPromise = params.run(mergedAbortSignal).catch((error: unknown) => {
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
    if (!timeoutMs) {
      await runPromise;
      return false;
    }
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      timeoutHandle.unref?.();
    });
    const result = await Promise.race([
      runPromise.then(() => "completed" as const),
      timeoutPromise,
    ]);
    if (result === "timeout") {
      timedOut = true;
      timeoutAbortController?.abort();
      await params.onTimeout(timeoutMs);
      return true;
    }
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function raceWithTimeout<T, U>(params: {
  promise: Promise<T>;
  timeoutMs: number;
  onTimeout: () => U;
}): Promise<T | U> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<U>((resolve) => {
    timeoutTimer = setTimeout(() => resolve(params.onTimeout()), timeoutMs);
    timeoutTimer.unref?.();
  });
  try {
    return await Promise.race([params.promise, timeoutPromise]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
}

export async function withAbortTimeout<T>(params: {
  timeoutMs: number;
  createTimeoutError: () => Error;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const controller = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      controller.abort();
      reject(params.createTimeoutError());
    }, timeoutMs);
    timeoutTimer.unref?.();
  });
  try {
    return await Promise.race([params.run(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
}
