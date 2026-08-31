export const DEFAULT_MEMORY_SEARCH_TIMEOUT_MS = 15_000;
export function resolveMemorySearchAbortError(signal: AbortSignal): Error {
  const { reason } = signal;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "memory search aborted");
}

// The deadline owner is the only place that knows a failure is this tool's own
// timeout: a provider is free to emit the same text, and the catch path has
// flattened both to a string before recovery guidance is chosen. Membership is
// by object identity, never by a property, because the supervised task receives
// this error as `signal.reason` and could copy any marker on it onto a failure
// of its own.
const memorySearchDeadlineErrors = new WeakSet<object>();

export function createMemorySearchDeadlineError(message: string): Error {
  const error = new Error(message);
  memorySearchDeadlineErrors.add(error);
  return error;
}

function createMemorySearchTimeoutError(timeoutMs: number): Error {
  return createMemorySearchDeadlineError(
    `memory_search timed out after ${Math.round(timeoutMs / 1000)}s`,
  );
}

export function isMemorySearchDeadlineError(error: unknown): boolean {
  return typeof error === "object" && error !== null && memorySearchDeadlineErrors.has(error);
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
