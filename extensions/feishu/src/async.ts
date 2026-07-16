const RACE_TIMEOUT = Symbol("race-timeout");
const RACE_ABORT = Symbol("race-abort");

export type RaceWithTimeoutAndAbortResult<T> =
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
    contenders.push(
      new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve(RACE_TIMEOUT), options.timeoutMs);
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
    const handleAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };

    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", handleAbort);
      resolve(true);
    }, delayMs);
    timer.unref?.();

    abortSignal?.addEventListener("abort", handleAbort, { once: true });
  });
}
