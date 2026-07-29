import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import {
  getAllActiveGeneratedMediaSessionKeys,
  getLatestGeneratedMediaTaskAdmissionIdForSessionKey,
  listActiveGeneratedMediaTaskIdsForSessionKey,
} from "./generated-media-task-activity.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
// Filters task status visibility by requester, owner, and flow scope.
import {
  findTaskByRunId,
  getTaskById,
  listTaskRecords,
  listTaskRecordsUnsorted,
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

type SubagentTaskRunStatusLookup = {
  childSessionKey: string;
  runId?: string;
  taskRunId?: string;
};

function isActiveTaskRecord(task: Pick<TaskRecord, "status">): boolean {
  return task.status === "queued" || task.status === "running";
}

function taskStatusSortTime(task: TaskRecord): number {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

function preferTaskForStatus(
  current: TaskRecord | undefined,
  candidate: TaskRecord,
  runId: string | undefined,
): TaskRecord {
  if (!current) {
    return candidate;
  }
  const currentExact = runId !== undefined && current.runId === runId;
  const candidateExact = runId !== undefined && candidate.runId === runId;
  if (currentExact !== candidateExact) {
    return candidateExact ? candidate : current;
  }
  const currentActive = isActiveTaskRecord(current);
  const candidateActive = isActiveTaskRecord(candidate);
  if (currentActive !== candidateActive) {
    return candidateActive ? candidate : current;
  }
  return taskStatusSortTime(candidate) >= taskStatusSortTime(current) ? candidate : current;
}

/** Finds subagent task evidence scoped to the exact child session and run owner. */
export function findSubagentTaskByRunIdForStatus(
  params: SubagentTaskRunStatusLookup,
): TaskRecord | undefined {
  const childSessionKey = params.childSessionKey.trim();
  const runId = params.runId?.trim() || undefined;
  const taskRunId = params.taskRunId?.trim() || undefined;
  const acceptedRunIds = new Set(
    [runId, taskRunId].filter((value): value is string => Boolean(value)),
  );
  if (!childSessionKey || acceptedRunIds.size === 0) {
    return undefined;
  }
  let selected: TaskRecord | undefined;
  for (const task of listTaskRecordsUnsorted()) {
    if (
      task.runtime !== "subagent" ||
      task.childSessionKey !== childSessionKey ||
      !task.runId ||
      !acceptedRunIds.has(task.runId)
    ) {
      continue;
    }
    selected = preferTaskForStatus(selected, task, runId);
  }
  return selected;
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

/**
 * Builds a one-shot snapshot of all session keys with pending generated-media
 * work. Consume this once per reaper sweep for O(1) per-row lookups instead of
 * repeating global task and activity scans for every cron continuation row.
 */
export function buildPendingGeneratedMediaSessionKeySet(): Set<string> {
  const keys = getAllActiveGeneratedMediaSessionKeys();
  for (const task of listTaskRecordsUnsorted()) {
    if (GENERATED_MEDIA_TASK_KINDS.has(task.taskKind ?? "") && !isTerminalTaskStatus(task.status)) {
      if (task.requesterSessionKey) {
        keys.add(task.requesterSessionKey);
      }
      if (task.ownerKey) {
        keys.add(task.ownerKey);
      }
    }
  }
  return keys;
}
