// Concurrency wrapper for media-understanding tasks that keeps successful
// outputs while verbose-logging per-provider failures.
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";

/** Runs media tasks under a fixed concurrency limit while preserving successful results. */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const { results } = await runTasksWithConcurrency({
    tasks,
    limit,
    // Media understanding tries every eligible entry; verbose mode keeps per-entry failures visible.
    onTaskError(err) {
      if (shouldLogVerbose()) {
        logVerbose(`Media understanding task failed: ${String(err)}`);
      }
    },
  });
  return results;
}
