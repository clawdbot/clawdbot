// Feishu plugin module implements async behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";

const RACE_TIMEOUT = Symbol("race-timeout");
const RACE_ABORT = Symbol("race-abort");

type RaceWithTimeoutAndAbortResult<T> =
  | { status: "resolved"; value: T }
  | { status: "timeout" }
  | { status: "aborted" };

export async function raceWithTimeoutAndAbort<T>(
  promise: Promise<T>,
  options: {
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  } = {},
): Promise<RaceWithTimeoutAndAbortResult<T>> {
  if (options.abortSignal?.aborted) {
    return { status: "aborted" };
  }

  if (options.timeoutMs === undefined && !options.abortSignal) {
    return { status: "resolved", value: await promise };
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const contenders: Array<Promise<T | typeof RACE_TIMEOUT | typeof RACE_ABORT>> = [promise];

  if (options.timeoutMs !== undefined) {
    const timeoutMs = resolveTimerTimeoutMs(options.timeoutMs, 1);
    contenders.push(
      new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(RACE_TIMEOUT), timeoutMs);
      }),
    );
  }

  if (options.abortSignal) {
    contenders.push(
      new Promise((resolve) => {
        abortHandler = () => resolve(RACE_ABORT);
        options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
      }),
    );
  }

  try {
    const result = await Promise.race(contenders);
    if (result === RACE_TIMEOUT) {
      return { status: "timeout" };
    }
    if (result === RACE_ABORT) {
      return { status: "aborted" };
    }
    return { status: "resolved", value: result };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (abortHandler) {
      options.abortSignal?.removeEventListener("abort", abortHandler);
    }
  }
}

export function waitForAbortableDelay(
  delayMs: number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (abortSignal?.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (handleAbort) {
        abortSignal?.removeEventListener("abort", handleAbort);
      }
      resolve(value);
    };

    const handleAbort: (() => void) | undefined = () => {
      finish(false);
    };

    abortSignal?.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal?.aborted) {
      finish(false);
      return;
    }

    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => finish(true),
      resolveTimerTimeoutMs(delayMs, 1),
    );
    timer.unref?.();
  });
}
