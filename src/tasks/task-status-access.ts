// Filters task status visibility by requester, owner, and flow scope.
import {
  findTaskByRunId,
  getTaskById,
  listTaskRecords,
  listTasksForAgentId,
  listTasksForSessionKey,
} from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Returns only the session lookup fields needed by task status commands. */
export function getTaskSessionLookupByIdForStatus(
  taskId: string,
): Pick<TaskRecord, "requesterSessionKey" | "runId" | "agentId"> | undefined {
  const task = getTaskById(taskId);
  return task
    ? {
        requesterSessionKey: task.requesterSessionKey,
        ...(task.runId ? { runId: task.runId } : {}),
        ...(task.agentId ? { agentId: task.agentId } : {}),
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
