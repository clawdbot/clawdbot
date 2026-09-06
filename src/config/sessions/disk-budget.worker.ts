import { serveWorkerTasks } from "../../infra/worker-task-pool.js";
import { readSessionPhysicalDiskUsage } from "./disk-budget-files.js";

serveWorkerTasks((input) => {
  // SAFETY: The paired runtime supplies the absolute store locator for this private worker.
  return readSessionPhysicalDiskUsage(input as string);
});
