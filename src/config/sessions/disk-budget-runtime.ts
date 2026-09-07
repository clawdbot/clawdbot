import path from "node:path";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { SessionPhysicalDiskUsage } from "./disk-budget-files.js";

const measurements = new WorkerTaskPool<string, SessionPhysicalDiskUsage>({
  workerUrl: resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "disk-budget.worker",
    distWorkerPath: "config/sessions/disk-budget.worker.js",
  }),
  // Share one scan worker so concurrent stores cannot multiply filesystem scan heaps.
  maxWorkers: 1,
});

/** Measures physical session artifacts without running per-file synchronous work on the caller. */
export async function measureSessionPhysicalDiskUsage(
  storePath: string,
): Promise<SessionPhysicalDiskUsage> {
  // Capture the locator before queueing; only four totals cross back to the caller.
  return measurements.run(path.resolve(storePath), {});
}
