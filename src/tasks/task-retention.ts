import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

export const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const LOST_TASK_RETENTION_MS = 24 * 60 * 60_000;

export function resolveTaskRetentionMs(status: TaskStatus): number {
  return status === "lost" ? LOST_TASK_RETENTION_MS : DEFAULT_TASK_RETENTION_MS;
}

export function resolveTaskCleanupAfter(
  task: Pick<TaskRecord, "status" | "endedAt" | "lastEventAt" | "createdAt">,
): number {
  const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return terminalAt + resolveTaskRetentionMs(task.status);
}

export function resolveEffectiveTaskCleanupAfter(
  task: Pick<TaskRecord, "status" | "endedAt" | "lastEventAt" | "createdAt" | "cleanupAfter">,
): number {
  const statusCleanupAfter = resolveTaskCleanupAfter(task);
  if (typeof task.cleanupAfter !== "number") {
    return statusCleanupAfter;
  }
  return task.status === "lost"
    ? Math.min(task.cleanupAfter, statusCleanupAfter)
    : task.cleanupAfter;
}
