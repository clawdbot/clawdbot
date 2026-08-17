export const DEFAULT_MEMORY_SEARCH_TIMEOUT_MS = 15_000;
class MemorySearchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`memory_search timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "MemorySearchTimeoutError";
  }
}

export function isMemorySearchTimeoutError(error: unknown): boolean {
  return error instanceof MemorySearchTimeoutError;
}

export function resolveMemorySearchAbortError(signal: AbortSignal): Error {
  const { reason } = signal;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "memory search aborted");
}

function createMemorySearchTimeoutError(timeoutMs: number): Error {
  return new MemorySearchTimeoutError(timeoutMs);
}

export async function runMemorySearchWithDeadline<T>(params: {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (params.parentSignal?.aborted) {
    throw resolveMemorySearchAbortError(params.parentSignal);
  }

  const controller = new AbortController();
  const timeoutError = createMemorySearchTimeoutError(params.timeoutMs);
  const timeoutOutcome = { type: "timeout" } as const;
  const parentAbortOutcome = { type: "parent-abort" } as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineStartedAt = Date.now();
  let removeParentAbort: (() => void) | undefined;
  let resolveTimeout!: (outcome: typeof timeoutOutcome) => void;
  const timeoutPromise = new Promise<typeof timeoutOutcome>((resolve) => {
    resolveTimeout = resolve;
  });
  const reachDefaultDeadline = () => {
    // Resolve before aborting so abort-aware tasks cannot replace the stable
    // deadline error with a provider-wrapped cancellation error.
    resolveTimeout(timeoutOutcome);
    controller.abort(timeoutError);
  };
  timer = setTimeout(() => {
    timer = undefined;
    reachDefaultDeadline();
  }, params.timeoutMs);
  timer.unref?.();
  const parentSignal = params.parentSignal;
  const parentAbortPromise = parentSignal
    ? new Promise<typeof parentAbortOutcome>((resolve) => {
        const onAbort = () => {
          resolve(parentAbortOutcome);
          controller.abort(resolveMemorySearchAbortError(parentSignal));
        };
        parentSignal.addEventListener("abort", onAbort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener("abort", onAbort);
      })
    : undefined;
  const task = Promise.resolve().then(() => params.run(controller.signal));
  task.catch(() => undefined);

  try {
    const result = await Promise.race(
      parentAbortPromise ? [task, timeoutPromise, parentAbortPromise] : [task, timeoutPromise],
    );
    if (result === parentAbortOutcome) {
      throw resolveMemorySearchAbortError(parentSignal!);
    }
    if (result === timeoutOutcome) {
      throw timeoutError;
    }
    if (parentSignal?.aborted) {
      throw resolveMemorySearchAbortError(parentSignal);
    }
    if (timer !== undefined && Date.now() - deadlineStartedAt >= params.timeoutMs) {
      reachDefaultDeadline();
      throw timeoutError;
    }
    return result as T;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    removeParentAbort?.();
  }
}
