// Memory Host SDK concurrency helpers preserve stop-and-drain semantics.
import pMap from "p-map";

/** Run tasks with bounded concurrency, stopping admission and draining active work on failure. */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const inFlight = new Set<Promise<T>>();
  try {
    return await pMap(
      tasks,
      (task) => {
        const run = Promise.resolve().then(task);
        inFlight.add(run);
        void run.then(
          () => inFlight.delete(run),
          () => inFlight.delete(run),
        );
        return run;
      },
      {
        concurrency: Math.max(1, Math.floor(limit)),
        stopOnError: true,
      },
    );
  } catch (error) {
    // p-map stops dequeuing on error, but active memory writes must drain before callers recover.
    await Promise.allSettled(inFlight);
    throw error;
  }
}
