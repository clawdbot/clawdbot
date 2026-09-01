// Normalizes task owner keys and checks requester access to task records.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  findTaskByRunId,
  getTaskById,
  listTasksForRelatedSessionKey,
  markTaskTerminalById as markTaskTerminalRecordById,
  resolveTaskForLookupToken,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";
import { resolveTaskSessionAgentId } from "./task-session-identity.js";
import { buildTaskStatusSnapshot } from "./task-status.js";

type TaskOwnerIdentity = {
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
};

function canOwnerAccessTask(task: TaskRecord, identity: TaskOwnerIdentity): boolean {
  if (
    task.scopeKind !== "session" ||
    normalizeOptionalString(task.ownerKey) !== normalizeOptionalString(identity.callerOwnerKey)
  ) {
    return false;
  }
  const callerAgentId =
    normalizeOptionalString(identity.callerAgentId) ??
    parseAgentSessionKey(identity.callerOwnerKey)?.agentId;
  // Bare owner keys can collide across per-agent stores, so an unscoped caller
  // without a trusted agent identity must fail closed.
  if (!callerAgentId) {
    return false;
  }
  const taskAgentId = resolveTaskSessionAgentId(
    task.ownerKey,
    task.requesterAgentId,
    identity.config ?? getRuntimeConfig,
  );
  return (
    Boolean(taskAgentId) &&
    normalizeOptionalString(taskAgentId) === normalizeOptionalString(callerAgentId)
  );
}

export function getTaskByIdForOwner(params: {
  taskId: string;
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
}): TaskRecord | undefined {
  const task = getTaskById(params.taskId);
  return task && canOwnerAccessTask(task, params) ? task : undefined;
}

export function findTaskByRunIdForOwner(params: {
  runId: string;
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
}): TaskRecord | undefined {
  const task = findTaskByRunId(params.runId);
  return task && canOwnerAccessTask(task, params) ? task : undefined;
}

/** Update an owner-visible task's notification policy. */
export function updateTaskNotifyPolicyForOwner(params: {
  taskId: string;
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
  notifyPolicy: TaskNotifyPolicy;
}): TaskRecord | null {
  const task = getTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.callerOwnerKey,
    callerAgentId: params.callerAgentId,
    config: params.config,
  });
  if (!task) {
    return null;
  }
  return updateTaskNotifyPolicyById({
    taskId: task.taskId,
    notifyPolicy: params.notifyPolicy,
  });
}

/** Mark an owner-visible task as cancelled with a caller-provided summary. */
export function cancelTaskByIdForOwner(params: {
  taskId: string;
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
  endedAt: number;
  terminalSummary?: string | null;
}): TaskRecord | null {
  const task = getTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.callerOwnerKey,
    callerAgentId: params.callerAgentId,
    config: params.config,
  });
  if (!task) {
    return null;
  }
  return markTaskTerminalRecordById({
    taskId: task.taskId,
    status: "cancelled",
    endedAt: params.endedAt,
    terminalSummary: params.terminalSummary,
  });
}

export function listTasksForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
}): TaskRecord[] {
  return listTasksForRelatedSessionKey(params.relatedSessionKey).filter((task) =>
    canOwnerAccessTask(task, params),
  );
}

export function buildTaskStatusSnapshotForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
}) {
  return buildTaskStatusSnapshot(
    listTasksForRelatedSessionKeyForOwner({
      relatedSessionKey: params.relatedSessionKey,
      callerOwnerKey: params.callerOwnerKey,
      callerAgentId: params.callerAgentId,
      config: params.config,
    }),
  );
}

export function findLatestTaskForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
}): TaskRecord | undefined {
  return listTasksForRelatedSessionKeyForOwner(params)[0];
}

export function resolveTaskForLookupTokenForOwner(params: {
  token: string;
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
}): TaskRecord | undefined {
  const direct = getTaskByIdForOwner({
    taskId: params.token,
    callerOwnerKey: params.callerOwnerKey,
    callerAgentId: params.callerAgentId,
    config: params.config,
  });
  if (direct) {
    return direct;
  }
  const byRun = findTaskByRunIdForOwner({
    runId: params.token,
    callerOwnerKey: params.callerOwnerKey,
    callerAgentId: params.callerAgentId,
    config: params.config,
  });
  if (byRun) {
    return byRun;
  }
  const related = findLatestTaskForRelatedSessionKeyForOwner({
    relatedSessionKey: params.token,
    callerOwnerKey: params.callerOwnerKey,
    callerAgentId: params.callerAgentId,
    config: params.config,
  });
  if (related) {
    return related;
  }
  const raw = resolveTaskForLookupToken(params.token);
  return raw && canOwnerAccessTask(raw, params) ? raw : undefined;
}
