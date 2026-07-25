export const DEFAULT_MEMORY_SEARCH_TIMEOUT_MS = 15_000;
// QMD pauses only for its query subprocess; fallback hands ownership to its
// own fresh default deadline. Manager maintenance remains on this clock.
export const MEMORY_SEARCH_DEADLINE_CONTROL = Symbol("memory-search-deadline-control");
export type MemorySearchDeadlineAction = "pause" | "resume" | "handoff";
export type MemorySearchDeadlineControlOptions = {
  [MEMORY_SEARCH_DEADLINE_CONTROL]?: (action: MemorySearchDeadlineAction) => void;
};

export function resolveMemorySearchAbortError(signal: AbortSignal): Error {
  const { reason } = signal;
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "memory search aborted");
}

function createMemorySearchTimeoutError(timeoutMs: number): Error {
  return new Error(`memory_search timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export async function runMemorySearchWithDeadline<T>(params: {
  timeoutMs: number;
  parentSignal?: AbortSignal;
  run: (
    signal: AbortSignal,
    controlDeadline: (action: MemorySearchDeadlineAction) => void,
  ) => Promise<T>;
}): Promise<T> {
  if (params.parentSignal?.aborted) {
    throw resolveMemorySearchAbortError(params.parentSignal);
  }

  const controller = new AbortController();
  const timeoutError = createMemorySearchTimeoutError(params.timeoutMs);
  const timeoutOutcome = { type: "timeout" } as const;
  const parentAbortOutcome = { type: "parent-abort" } as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remainingMs = params.timeoutMs;
  let deadlineStartedAt = Date.now();
  let removeParentAbort: (() => void) | undefined;
  let acceptDeadlineUpdates = true;
  let resolveTimeout!: (outcome: typeof timeoutOutcome) => void;
  const timeoutPromise = new Promise<typeof timeoutOutcome>((resolve) => {
    resolveTimeout = resolve;
  });
  const reachDefaultDeadline = () => {
    acceptDeadlineUpdates = false;
    // Resolve before aborting so abort-aware tasks cannot replace the stable
    // deadline error with a provider-wrapped cancellation error.
    resolveTimeout(timeoutOutcome);
    controller.abort(timeoutError);
  };
  const scheduleDefaultDeadline = () => {
    deadlineStartedAt = Date.now();
    timer = setTimeout(() => {
      timer = undefined;
      reachDefaultDeadline();
    }, remainingMs);
    timer.unref?.();
  };
  const controlDeadline = (action: MemorySearchDeadlineAction) => {
    if (!acceptDeadlineUpdates) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      remainingMs = Math.max(0, remainingMs - (Date.now() - deadlineStartedAt));
    }
    if (remainingMs === 0) {
      reachDefaultDeadline();
      return;
    }
    if (action === "handoff") {
      acceptDeadlineUpdates = false;
    } else if (action === "resume") {
      scheduleDefaultDeadline();
    }
  };
  scheduleDefaultDeadline();
  const parentSignal = params.parentSignal;
  const parentAbortPromise = parentSignal
    ? new Promise<typeof parentAbortOutcome>((resolve) => {
        const onAbort = () => {
          acceptDeadlineUpdates = false;
          resolve(parentAbortOutcome);
          controller.abort(resolveMemorySearchAbortError(parentSignal));
        };
        parentSignal.addEventListener("abort", onAbort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener("abort", onAbort);
      })
    : undefined;
  const task = Promise.resolve().then(() => params.run(controller.signal, controlDeadline));
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
    if (
      acceptDeadlineUpdates &&
      timer !== undefined &&
      Date.now() - deadlineStartedAt >= remainingMs
    ) {
      reachDefaultDeadline();
      throw timeoutError;
    }
    return result as T;
  } finally {
    acceptDeadlineUpdates = false;
    if (timer) {
      clearTimeout(timer);
    }
    removeParentAbort?.();
  }
}
