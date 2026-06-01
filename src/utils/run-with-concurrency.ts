/** Controls whether the worker pool keeps scheduling after a task failure. */
export type ConcurrencyErrorMode = "continue" | "stop";

/** Runs async tasks with bounded concurrency while preserving result indexes. */
export async function runTasksWithConcurrency<T>(params: {
  tasks: Array<() => Promise<T>>;
  limit: number;
  errorMode?: ConcurrencyErrorMode;
  onTaskError?: (error: unknown, index: number) => void;
}): Promise<{ results: T[]; firstError: unknown; hasError: boolean }> {
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
