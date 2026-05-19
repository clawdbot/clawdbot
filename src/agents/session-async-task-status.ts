import { normalizeOptionalString } from "../shared/string-coerce.js";
import { listTasksForOwnerKey } from "../tasks/runtime-internal.js";
import type { TaskRecord, TaskRuntime, TaskStatus } from "../tasks/task-registry.types.js";

const DEFAULT_ACTIVE_STATUSES = new Set<TaskStatus>(["queued", "running"]);

export function findActiveSessionTask(params: {
  sessionKey?: string;
  runtime?: TaskRuntime;
  taskKind?: string;
  task?: string;
  statuses?: ReadonlySet<TaskStatus>;
  sourceIdPrefix?: string;
}): TaskRecord | undefined {
  const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
  if (!normalizedSessionKey) {
    return undefined;
  }
  const statuses = params.statuses ?? DEFAULT_ACTIVE_STATUSES;
  const taskKind = normalizeOptionalString(params.taskKind);
  const taskLabel = normalizeOptionalString(params.task);
  const sourceIdPrefix = normalizeOptionalString(params.sourceIdPrefix);
  const matches = listTasksForOwnerKey(normalizedSessionKey).filter((task) => {
    if (task.scopeKind !== "session") {
      return false;
    }
    if (params.runtime && task.runtime !== params.runtime) {
      return false;
    }
    if (!statuses.has(task.status)) {
      return false;
    }
    if (taskKind && task.taskKind !== taskKind) {
      return false;
    }
    if (taskLabel) {
      const currentTaskLabel = normalizeOptionalString(task.task);
      if (currentTaskLabel !== taskLabel) {
        return false;
      }
    }
    if (sourceIdPrefix) {
      const sourceId = normalizeOptionalString(task.sourceId) ?? "";
      if (sourceId !== sourceIdPrefix && !sourceId.startsWith(`${sourceIdPrefix}:`)) {
        return false;
      }
    }
    return true;
  });
  if (matches.length === 0) {
    return undefined;
  }
  return matches.find((task) => task.status === "running") ?? matches[0];
}

export function buildSessionAsyncTaskStatusDetails(task: TaskRecord): Record<string, unknown> {
  return {
    async: true,
    active: true,
    existingTask: true,
    status: task.status,
    task: {
      taskId: task.taskId,
      ...(task.runId ? { runId: task.runId } : {}),
    },
    ...(task.taskKind ? { taskKind: task.taskKind } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
  };
}
