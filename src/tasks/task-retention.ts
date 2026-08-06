// Computes task retention windows and pruning eligibility for registry cleanup.
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

/** Default retention for terminal task records before maintenance prunes them. */
const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOST_TASK_RETENTION_MS = 24 * 60 * 60_000;

function resolveTaskRetentionMs(status: TaskStatus): number {
  return status === "lost" ? LOST_TASK_RETENTION_MS : DEFAULT_TASK_RETENTION_MS;
}

export function resolveTaskCleanupAfter(
  task: Pick<TaskRecord, "runtime" | "status" | "endedAt" | "lastEventAt" | "createdAt">,
): number | undefined {
  if (task.runtime === "cron" && task.status !== "lost") {
    return undefined;
  }
  const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return terminalAt + resolveTaskRetentionMs(task.status);
}

export function resolveEffectiveTaskCleanupAfter(
  task: Pick<
    TaskRecord,
    "runtime" | "status" | "endedAt" | "lastEventAt" | "createdAt" | "cleanupAfter"
  >,
): number | undefined {
  const statusCleanupAfter = resolveTaskCleanupAfter(task);
  if (statusCleanupAfter === undefined) {
    return undefined;
  }
  if (typeof task.cleanupAfter !== "number") {
    return statusCleanupAfter;
  }
  return task.status === "lost"
    ? Math.min(task.cleanupAfter, statusCleanupAfter)
    : task.cleanupAfter;
}
