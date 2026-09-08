import { AsyncLocalStorage } from "node:async_hooks";
import pMap from "p-map";

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
  /** Reject immediately on a task failure instead of returning aggregate error state. */
  throwOnError?: boolean;
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
  const { tasks, limit, onTaskError, throwOnError = false } = params;
  const errorMode = params.errorMode ?? "continue";
  if (tasks.length === 0) {
    return { results: [], firstError: undefined, hasError: false };
  }

  const resolvedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), tasks.length))
    : tasks.length;
  const results: T[] = Array.from({ length: tasks.length });
  let firstError: unknown = undefined;
  let hasError = false;
  // Admit tasks lazily instead of allocating a queued promise for every input.
  // Caller rejection is separate from mapper completion so continue mode still drains.
  return new Promise((resolve, reject) => {
    const runOne = async (task: () => Promise<T>, index: number) => {
      if (errorMode === "stop" && hasError) {
        return;
      }
      try {
        results[index] = await task();
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
        let rejectionError = error;
        try {
          onTaskError?.(error, index);
        } catch (callbackError) {
          rejectionError = callbackError;
        }
        if (throwOnError) {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the public runner's original task or error-hook rejection value.
          reject(rejectionError);
        }
      }
    };
    // Capture the caller context, but run each task in a fresh continuation so
    // enterWith cannot mutate the shared bound resource on Node 22.
    const mapper = AsyncLocalStorage.bind((task: () => Promise<T>, index: number) =>
      Promise.resolve().then(() => runOne(task, index)),
    );
    void pMap(tasks.slice(), mapper, { concurrency: resolvedLimit }).then(
      () => resolve({ results, firstError, hasError }),
      reject,
    );
  });
}
