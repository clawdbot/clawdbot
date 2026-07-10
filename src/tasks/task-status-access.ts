import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import {
  getLatestGeneratedMediaTaskAdmissionIdForSessionKey,
  listActiveGeneratedMediaTaskIdsForSessionKey,
} from "./generated-media-task-activity.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
// Filters task status visibility by requester, owner, and flow scope.
import {
  findTaskByRunId,
  getTaskById,
  listTaskRecords,
  listTasksForAgentId,
  listTasksForSessionKey,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

const GENERATED_MEDIA_TASK_KINDS = new Set([
  "image_generation",
  "music_generation",
  "video_generation",
]);

/** Returns only the session lookup fields needed by task status commands. */
export function getTaskSessionLookupByIdForStatus(
  taskId: string,
):
  | Pick<TaskRecord, "requesterSessionKey" | "ownerKey" | "runId" | "agentId" | "requesterAgentId">
  | undefined {
  const task = getTaskById(taskId);
  return task
    ? {
        requesterSessionKey: task.requesterSessionKey,
        ownerKey: task.ownerKey,
        ...(task.runId ? { runId: task.runId } : {}),
        ...(task.agentId ? { agentId: task.agentId } : {}),
        ...(task.requesterAgentId ? { requesterAgentId: task.requesterAgentId } : {}),
      }
    : undefined;
}

export function listTasksForSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return listTasksForSessionKey(sessionKey);
}

export function listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return listTaskRecords().filter(
    (task) => task.requesterSessionKey === sessionKey || task.ownerKey === sessionKey,
  );
}

export function listTasksForAgentIdForStatus(agentId: string): TaskRecord[] {
  return listTasksForAgentId(agentId);
}

export function findTaskByRunIdForStatus(runId: string): TaskRecord | undefined {
  return findTaskByRunId(runId);
}

/** Snapshots generated-media task ids so replay guards stay attempt-local. */
export function getGeneratedMediaTaskIdsForSessionKey(
  sessionKey: string | undefined,
): ReadonlySet<string> {
  if (!sessionKey || !parseCronRunScopeSuffix(sessionKey).runId) {
    return new Set();
  }
  const taskIds = listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey)
    .filter((task) => GENERATED_MEDIA_TASK_KINDS.has(task.taskKind ?? ""))
    .map((task) => task.taskId);
  const latestAdmission = getLatestGeneratedMediaTaskAdmissionIdForSessionKey(sessionKey);
  return new Set([...taskIds, ...(latestAdmission ? [`run:${latestAdmission}`] : [])]);
}

/** Returns whether one attempt admitted generated-media work after its snapshot. */
export function hasNewGeneratedMediaTaskForSessionKey(
  sessionKey: string | undefined,
  before: ReadonlySet<string>,
): boolean {
  for (const taskId of getGeneratedMediaTaskIdsForSessionKey(sessionKey)) {
    if (!before.has(taskId)) {
      return true;
    }
  }
  return false;
}

/** Returns whether generated-media work still needs this run's continuation row. */
export function hasPendingGeneratedMediaTaskForSessionKey(sessionKey: string): boolean {
  if (!parseCronRunScopeSuffix(sessionKey).runId) {
    return false;
  }
  if (listActiveGeneratedMediaTaskIdsForSessionKey(sessionKey).length > 0) {
    return true;
  }
  return listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey).some(
    (task) =>
      GENERATED_MEDIA_TASK_KINDS.has(task.taskKind ?? "") && !isTerminalTaskStatus(task.status),
  );
}
