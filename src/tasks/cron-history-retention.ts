/** Enforces the task-ledger retention bound for terminal cron history. */
import { cronTaskRecordStoreKey, resolveCronTaskRecordTimestamp } from "../cron/task-run-detail.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resolveEffectiveTaskCleanupAfter } from "./task-retention.js";

// Replaces configurable cron.runLog.keepLines with one ledger-owned bound.
export const CRON_HISTORY_KEEP_PER_JOB = 2000;

function isTerminalTask(task: TaskRecord): boolean {
  return task.status !== "queued" && task.status !== "running";
}

export function collectCronHistoryOverflowTaskIds(tasks: readonly TaskRecord[]): Set<string> {
  // Cron job ids are unique only within a configured store. Retention must
  // use the same storeKey/sourceId partition as history reads.
  const byStore = new Map<string | undefined, Map<string, TaskRecord[]>>();
  for (const task of tasks) {
    if (
      task.runtime !== "cron" ||
      !task.sourceId ||
      !isTerminalTask(task) ||
      task.status === "lost"
    ) {
      continue;
    }
    const storeKey = cronTaskRecordStoreKey(task);
    const bySource = byStore.get(storeKey) ?? new Map<string, TaskRecord[]>();
    const rows = bySource.get(task.sourceId) ?? [];
    rows.push(task);
    bySource.set(task.sourceId, rows);
    byStore.set(storeKey, bySource);
  }
  const overflow = new Set<string>();
  for (const bySource of byStore.values()) {
    for (const rows of bySource.values()) {
      rows.sort((left, right) => {
        return (
          resolveCronTaskRecordTimestamp(right) - resolveCronTaskRecordTimestamp(left) ||
          right.taskId.localeCompare(left.taskId)
        );
      });
      for (const task of rows.slice(CRON_HISTORY_KEEP_PER_JOB)) {
        overflow.add(task.taskId);
      }
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
