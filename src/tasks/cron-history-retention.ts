/** Enforces the task-ledger retention bound for terminal cron history. */
import type { TaskRecord } from "./task-registry.types.js";
import { resolveEffectiveTaskCleanupAfter } from "./task-retention.js";

// Replaces configurable cron.runLog.keepLines with one ledger-owned bound.
export const CRON_HISTORY_KEEP_PER_JOB = 2000;

function isTerminalTask(task: TaskRecord): boolean {
  return task.status !== "queued" && task.status !== "running";
}

export function collectCronHistoryOverflowTaskIds(tasks: readonly TaskRecord[]): Set<string> {
  // sourceId is the ledger's global cron-job owner key; storeKey remains only
  // a history-read partition and must not split the per-source retention cap.
  const bySource = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    if (
      task.runtime !== "cron" ||
      !task.sourceId ||
      !isTerminalTask(task) ||
      task.status === "lost"
    ) {
      continue;
    }
    const rows = bySource.get(task.sourceId) ?? [];
    rows.push(task);
    bySource.set(task.sourceId, rows);
  }
  const overflow = new Set<string>();
  for (const rows of bySource.values()) {
    rows.sort((left, right) => {
      const leftAt = left.endedAt ?? left.lastEventAt ?? left.createdAt;
      const rightAt = right.endedAt ?? right.lastEventAt ?? right.createdAt;
      return rightAt - leftAt || right.taskId.localeCompare(left.taskId);
    });
    for (const task of rows.slice(CRON_HISTORY_KEEP_PER_JOB)) {
      overflow.add(task.taskId);
    }
  }
  return overflow;
}

export function shouldPruneTerminalTask(
  task: TaskRecord,
  now: number,
  cronHistoryOverflowTaskIds: ReadonlySet<string>,
): boolean {
  if (!isTerminalTask(task)) {
    return false;
  }
  if (cronHistoryOverflowTaskIds.has(task.taskId)) {
    return true;
  }
  const cleanupAfter = resolveEffectiveTaskCleanupAfter(task);
  return cleanupAfter !== undefined && now >= cleanupAfter;
}
