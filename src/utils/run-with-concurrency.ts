/** Controls whether the worker pool keeps scheduling after a task failure. */
export type ConcurrencyErrorMode = "continue" | "stop";

/** Options for running a fixed list of promise factories through a bounded worker pool. */
export type RunTasksWithConcurrencyOptions<T> = {
  /** Task factories are started lazily so the helper can enforce `limit`. */
  tasks: Array<() => Promise<T>>;
  /** Maximum number of tasks allowed to run at the same time; clamped to at least one. */
  limit: number;
  /** `stop` prevents new work after the first failure; in-flight workers still settle. */
  errorMode?: ConcurrencyErrorMode;
  /** Called once per failed task with the original task index. */
  onTaskError?: (error: unknown, index: number) => void;
};

/** Ordered task results plus aggregate error state for callers that keep partial success. */
export type RunTasksWithConcurrencyResult<T> = {
  /** Results are written at their original task indexes; failed or unscheduled indexes stay empty. */
  results: T[];
  /** First task error observed by the worker pool, if any. */
  firstError: unknown;
  /** True when at least one task rejected. */
  hasError: boolean;
};

/** Runs async tasks with bounded concurrency while preserving result indexes. */
export async function runTasksWithConcurrency<T>(
  params: RunTasksWithConcurrencyOptions<T>,
): Promise<RunTasksWithConcurrencyResult<T>> {
  const { tasks, limit, onTaskError } = params;
  const errorMode = params.errorMode ?? "continue";
  if (tasks.length === 0) {
    return { results: [], firstError: undefined, hasError: false };
  }

  const resolvedLimit = Math.max(1, Math.min(limit, tasks.length));
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  let firstError: unknown = undefined;
  let hasError = false;

  const workers = Array.from({ length: resolvedLimit }, async () => {
    while (true) {
      if (errorMode === "stop" && hasError) {
        return;
      }
      // Synchronous cursor adoption is the whole scheduling lock: each worker
      // claims one stable index before awaiting task work.
      const index = next;
      next += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
        onTaskError?.(error, index);
        if (errorMode === "stop") {
          return;
        }
      }
    }
  });

  await Promise.allSettled(workers);
  return { results, firstError, hasError };
}
