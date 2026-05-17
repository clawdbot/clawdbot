import { getTaskById, listTasksForAgentId, listTasksForSessionKey } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

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

export function listTasksForAgentIdForStatus(agentId: string): TaskRecord[] {
  return listTasksForAgentId(agentId);
}
