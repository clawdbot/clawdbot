// Clones and normalizes task registry records at persistence boundaries.
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export function cloneTaskRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    ...(record.detail !== undefined ? { detail: structuredClone(record.detail) } : {}),
  };
}

export function normalizeTaskTimestamps(task: TaskRecord): TaskRecord {
  // Detached runtimes can report lifecycle times captured before the registry
  // inserted or restored the row; keep createdAt as the visible lifecycle floor.
  let createdAt = task.createdAt;
  for (const candidate of [task.startedAt, task.lastEventAt, task.endedAt]) {
    if (typeof candidate === "number" && candidate < createdAt) {
      createdAt = candidate;
    }
  }

  const startedAt =
    typeof task.startedAt === "number" ? Math.max(task.startedAt, createdAt) : task.startedAt;
  const terminalAt = isTerminalTaskStatus(task.status)
    ? (task.endedAt ?? task.lastEventAt ?? task.createdAt)
    : task.endedAt;
  const endedAt =
    typeof terminalAt === "number" ? Math.max(terminalAt, startedAt ?? createdAt) : terminalAt;
  const lastEventAt =
    typeof task.lastEventAt === "number"
      ? Math.max(task.lastEventAt, endedAt ?? startedAt ?? createdAt)
      : task.lastEventAt;

  if (
    createdAt === task.createdAt &&
    startedAt === task.startedAt &&
    lastEventAt === task.lastEventAt &&
    endedAt === task.endedAt
  ) {
    return task;
  }

  const normalized: TaskRecord = {
    ...task,
    createdAt,
  };
  if (typeof startedAt === "number") {
    normalized.startedAt = startedAt;
  }
  if (typeof lastEventAt === "number") {
    normalized.lastEventAt = lastEventAt;
  }
  if (typeof endedAt === "number") {
    normalized.endedAt = endedAt;
  }
  return normalized;
}

export function cloneTaskDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  return {
    ...state,
    ...(state.requesterOrigin ? { requesterOrigin: { ...state.requesterOrigin } } : {}),
  };
}
