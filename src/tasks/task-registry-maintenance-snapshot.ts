import { collectCronHistoryOverflowTaskIds } from "./cron-history-retention.js";
import { compareTasksNewestFirst, ensureTaskRegistryReady, tasks } from "./task-registry-state.js";

// Raw records stay inside this synchronous snapshot. Maintenance carries only
// IDs and retention decisions across awaits, then rereads and clones each task.
export function getTaskRegistryMaintenanceSnapshot(): {
  taskIds: readonly string[];
  cronHistoryOverflowTaskIds: ReadonlySet<string>;
} {
  ensureTaskRegistryReady();
  const ordered = [...tasks.values()]
    .map((task, insertionIndex) => ({ task, createdAt: task.createdAt, insertionIndex }))
    .toSorted(compareTasksNewestFirst)
    .map(({ task }) => task);
  return {
    taskIds: ordered.map((task) => task.taskId),
    cronHistoryOverflowTaskIds: collectCronHistoryOverflowTaskIds(ordered),
  };
}
