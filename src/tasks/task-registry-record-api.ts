import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import {
  appendTaskEvent,
  assertParentFlowLinkAllowed,
  assertTaskOwner,
  ensureDeliveryStatus,
  ensureNotifyPolicy,
  normalizeTaskStatus,
  normalizeTaskSummary,
  resolveTaskOwnerKey,
  resolveTaskRequesterSessionKey,
  resolveTaskScopeKind,
  resolveTaskTerminalOutcome,
  shouldApplyRunScopedStatusUpdate,
} from "./task-registry-common.js";
import {
  findExistingTaskForCreate,
  mergeExistingTaskForCreate,
  resolveTaskAgentId,
  resolveTaskRequesterAgentId,
} from "./task-registry-create-helpers.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { syncFlowFromTaskAfterTaskMutation, updateTask } from "./task-registry-mutation.js";
import { cloneTaskRecord, normalizeTaskTimestamps } from "./task-registry-records.js";
import {
  addOwnerKeyIndex,
  addParentFlowIdIndex,
  addRelatedSessionKeyIndex,
  addRunIdIndex,
  emitTaskRegistryObserverEvent,
  ensureTaskRegistryReady,
  getTasksByRunScope,
  taskDeliveryStates,
  tasks,
  tryPersistTaskUpsert,
} from "./task-registry-state.js";
import type {
  JsonValue,
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";
import { resolveTaskCleanupAfter } from "./task-retention.js";

export function setTaskCleanupAfterById(params: {
  taskId: string;
  cleanupAfter: number;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    cleanupAfter: params.cleanupAfter,
  });
}

export function markTaskTerminalById(params: {
  taskId: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  childSessionKey?: string | null;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  terminalSummary?: string | null;
  preserveTerminalSummary?: boolean;
  terminalOutcome?: TaskTerminalOutcome | null;
  detail?: JsonValue;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  const patch: Partial<TaskRecord> = {
    status: params.status,
    ...(params.childSessionKey !== undefined
      ? { childSessionKey: params.childSessionKey?.trim() || undefined }
      : {}),
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt ?? params.endedAt,
    ...(params.terminalSummary !== undefined
      ? {
          terminalSummary: params.preserveTerminalSummary
            ? (params.terminalSummary ?? undefined)
            : normalizeTaskSummary(params.terminalSummary),
        }
      : {}),
    ...(params.terminalOutcome !== undefined
      ? {
          terminalOutcome: resolveTaskTerminalOutcome({
            status: params.status,
            terminalOutcome: params.terminalOutcome,
          }),
        }
      : {}),
    ...(params.detail !== undefined ? { detail: structuredClone(params.detail) } : {}),
  };
  if (Object.hasOwn(params, "error")) {
    patch.error = params.error;
  }
  return updateTask(params.taskId, patch);
}

export function markTaskLostById(params: {
  taskId: string;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  cleanupAfter?: number;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    status: "lost",
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt ?? params.endedAt,
    ...(params.error !== undefined ? { error: params.error } : {}),
    ...(params.cleanupAfter !== undefined ? { cleanupAfter: params.cleanupAfter } : {}),
  });
}

function updateTasksByRunId(params: {
  runId: string;
  patch: Partial<TaskRecord>;
  runtime?: TaskRuntime;
  sessionKey?: string;
}): TaskRecord[] {
  const matches = getTasksByRunScope(params);
  if (matches.length === 0) {
    return [];
  }
  const updated: TaskRecord[] = [];
  for (const match of matches) {
    const task = updateTask(match.taskId, params.patch);
    if (task) {
      updated.push(task);
    }
  }
  return updated;
}

export function createTaskRecord(params: {
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  requesterAgentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  status?: TaskStatus;
  deliveryStatus?: TaskDeliveryStatus;
  notifyPolicy?: TaskNotifyPolicy;
  startedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
  detail?: JsonValue;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  const requesterSessionKey = resolveTaskRequesterSessionKey(params);
  const scopeKind = resolveTaskScopeKind({
    scopeKind: params.scopeKind,
    requesterSessionKey,
  });
  const ownerKey = resolveTaskOwnerKey({
    requesterSessionKey,
    ownerKey: params.ownerKey,
  });
  const agentId = resolveTaskAgentId({
    explicitAgentId: params.agentId,
    childSessionKey: params.childSessionKey,
    ownerKey,
    requesterSessionKey,
  });
  const requesterAgentId = resolveTaskRequesterAgentId({
    explicitRequesterAgentId: params.requesterAgentId,
    ownerKey,
    requesterSessionKey,
  });
  assertTaskOwner({
    ownerKey,
    scopeKind,
  });
  assertParentFlowLinkAllowed({
    ownerKey,
    scopeKind,
    parentFlowId: params.parentFlowId,
  });
  const existing = findExistingTaskForCreate({
    runtime: params.runtime,
    ownerKey,
    scopeKind,
    childSessionKey: params.childSessionKey,
    parentFlowId: params.parentFlowId,
    runId: params.runId,
    label: params.label,
    task: params.task,
  });
  if (existing) {
    return mergeExistingTaskForCreate(existing, { ...params, agentId });
  }
  const now = Date.now();
  const taskId = crypto.randomUUID();
  const status = normalizeTaskStatus(params.status);
  const deliveryStatus =
    params.deliveryStatus ??
    ensureDeliveryStatus({
      ownerKey,
      scopeKind,
    });
  const notifyPolicy = ensureNotifyPolicy({
    notifyPolicy: params.notifyPolicy,
    deliveryStatus,
    ownerKey,
    scopeKind,
  });
  const lastEventAt = params.lastEventAt ?? params.startedAt ?? now;
  const record: TaskRecord = normalizeTaskTimestamps({
    taskId,
    runtime: params.runtime,
    taskKind: normalizeOptionalString(params.taskKind),
    sourceId: normalizeOptionalString(params.sourceId),
    requesterSessionKey,
    ownerKey,
    scopeKind,
    childSessionKey: params.childSessionKey,
    parentFlowId: normalizeOptionalString(params.parentFlowId),
    parentTaskId: normalizeOptionalString(params.parentTaskId),
    agentId,
    requesterAgentId,
    runId: normalizeOptionalString(params.runId),
    label: normalizeOptionalString(params.label),
    task: params.task,
    status,
    deliveryStatus,
    notifyPolicy,
    createdAt: now,
    startedAt: params.startedAt,
    lastEventAt,
    cleanupAfter: params.cleanupAfter,
    progressSummary: normalizeTaskSummary(params.progressSummary),
    terminalSummary: normalizeTaskSummary(params.terminalSummary),
    terminalOutcome: resolveTaskTerminalOutcome({
      status,
      terminalOutcome: params.terminalOutcome,
    }),
    ...(params.detail !== undefined ? { detail: structuredClone(params.detail) } : {}),
  });
  if (isTerminalTaskStatus(record.status) && typeof record.cleanupAfter !== "number") {
    const cleanupAfter = resolveTaskCleanupAfter(record);
    Object.assign(record, cleanupAfter === undefined ? {} : { cleanupAfter });
  }
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const deliveryState = requesterOrigin
    ? {
        taskId,
        requesterOrigin,
      }
    : undefined;
  if (!tryPersistTaskUpsert(record, "create", deliveryState)) {
    return null;
  }
  tasks.set(taskId, record);
  if (requesterOrigin) {
    taskDeliveryStates.set(taskId, deliveryState!);
  }
  addRunIdIndex(taskId, record.runId);
  addOwnerKeyIndex(taskId, record);
  addParentFlowIdIndex(taskId, record);
  addRelatedSessionKeyIndex(taskId, record);
  syncFlowFromTaskAfterTaskMutation(record, "create");
  emitTaskRegistryObserverEvent(() => ({
    kind: "upserted",
    task: cloneTaskRecord(record),
  }));
  if (isTerminalTaskStatus(record.status)) {
    void maybeDeliverTaskTerminalUpdate(taskId);
  }
  return cloneTaskRecord(record);
}

export function updateTaskStateByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  childSessionKey?: string | null;
  status?: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  clearError?: boolean;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  preserveTerminalSummary?: boolean;
  terminalOutcome?: TaskTerminalOutcome | null;
  detail?: JsonValue;
  eventSummary?: string | null;
  suppressDelivery?: boolean;
}) {
  ensureTaskRegistryReady();
  const matches = getTasksByRunScope(params);
  if (matches.length === 0) {
    return [];
  }
  const updated: TaskRecord[] = [];
  for (const current of matches) {
    const patch: Partial<TaskRecord> = {};
    const nextStatus = params.status ? normalizeTaskStatus(params.status) : current.status;
    if (
      params.status &&
      !shouldApplyRunScopedStatusUpdate({
        currentStatus: current.status,
        currentRuntime: current.runtime,
        currentChildSessionKey: current.childSessionKey,
        currentError: current.error,
        currentEndedAt: current.endedAt,
        nextStatus,
        nextError: params.error,
        nextEndedAt: params.endedAt,
      })
    ) {
      continue;
    }
    const eventAt = params.lastEventAt ?? params.endedAt ?? Date.now();
    if (params.status) {
      patch.status = normalizeTaskStatus(params.status);
    }
    if (params.startedAt != null) {
      patch.startedAt = params.startedAt;
    }
    if (params.endedAt != null) {
      patch.endedAt = params.endedAt;
    }
    if (params.lastEventAt != null) {
      patch.lastEventAt = params.lastEventAt;
    }
    if (params.childSessionKey !== undefined) {
      patch.childSessionKey = params.childSessionKey?.trim() || undefined;
    }
    if (params.clearError) {
      patch.error = undefined;
    } else if (
      current.status === "cancelled" &&
      nextStatus !== "cancelled" &&
      params.error === undefined
    ) {
      patch.error = undefined;
    } else if (params.error !== undefined) {
      patch.error = params.error;
    }
    if (params.progressSummary !== undefined) {
      patch.progressSummary = normalizeTaskSummary(params.progressSummary);
    }
    if (params.terminalSummary !== undefined) {
      patch.terminalSummary = params.preserveTerminalSummary
        ? (params.terminalSummary ?? undefined)
        : normalizeTaskSummary(params.terminalSummary);
    }
    if (params.terminalOutcome !== undefined) {
      patch.terminalOutcome = resolveTaskTerminalOutcome({
        status: nextStatus,
        terminalOutcome: params.terminalOutcome,
      });
    }
    if (params.detail !== undefined) {
      patch.detail = params.detail;
    }
    if (params.suppressDelivery) {
      // Teardown suppression must survive redundant lifecycle finalizers that
      // arrive after queues are cleared, or they can repopulate the stopped session.
      patch.deliveryStatus = "not_applicable";
    }
    const eventSummary =
      normalizeTaskSummary(params.eventSummary) ??
      (nextStatus === "failed"
        ? normalizeTaskSummary(params.error ?? current.error)
        : nextStatus === "succeeded"
          ? normalizeTaskSummary(params.terminalSummary ?? current.terminalSummary)
          : undefined);
    const shouldAppendEvent =
      (params.status && params.status !== current.status) ||
      Boolean(normalizeTaskSummary(params.eventSummary));
    const nextEvent = shouldAppendEvent
      ? appendTaskEvent({
          at: eventAt,
          kind:
            params.status && normalizeTaskStatus(params.status) !== current.status
              ? normalizeTaskStatus(params.status)
              : "progress",
          summary: eventSummary,
        })
      : undefined;
    const task = updateTask(current.taskId, patch);
    if (task) {
      updated.push(task);
      if (!params.suppressDelivery) {
        void maybeDeliverTaskStateChangeUpdate(task.taskId, nextEvent);
        void maybeDeliverTaskTerminalUpdate(task.taskId);
      }
    }
  }
  return updated;
}

function updateTaskDeliveryByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
  error?: string;
}) {
  ensureTaskRegistryReady();
  const patch: Partial<TaskRecord> = {
    deliveryStatus: params.deliveryStatus,
  };
  if (params.error !== undefined) {
    patch.error = params.error;
  }
  return updateTasksByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    patch,
  });
}

export function markTaskRunningByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: "running",
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export function recordTaskProgressByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    eventSummary: params.eventSummary,
  });
}

export function finalizeTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  childSessionKey?: string | null;
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  startedAt?: number;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  clearError?: boolean;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  preserveTerminalSummary?: boolean;
  terminalOutcome?: TaskTerminalOutcome | null;
  detail?: JsonValue;
  suppressDelivery?: boolean;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    childSessionKey: params.childSessionKey,
    status: params.status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt,
    error: params.error,
    clearError: params.clearError,
    progressSummary: params.progressSummary,
    terminalSummary: params.terminalSummary,
    preserveTerminalSummary: params.preserveTerminalSummary,
    terminalOutcome: params.terminalOutcome,
    detail: params.detail,
    suppressDelivery: params.suppressDelivery,
  });
}

export function setTaskRunDeliveryStatusByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
  error?: string;
}) {
  return updateTaskDeliveryByRunId(params);
}

export function updateTaskNotifyPolicyById(params: {
  taskId: string;
  notifyPolicy: TaskNotifyPolicy;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  return updateTask(params.taskId, {
    notifyPolicy: params.notifyPolicy,
    lastEventAt: Date.now(),
  });
}

export function linkTaskToFlowById(params: { taskId: string; flowId: string }): TaskRecord | null {
  ensureTaskRegistryReady();
  const flowId = params.flowId.trim();
  if (!flowId) {
    return null;
  }
  const current = tasks.get(params.taskId);
  if (!current) {
    return null;
  }
  if (current.parentFlowId?.trim()) {
    return cloneTaskRecord(current);
  }
  assertParentFlowLinkAllowed({
    ownerKey: current.ownerKey,
    scopeKind: current.scopeKind,
    parentFlowId: flowId,
  });
  return updateTask(params.taskId, {
    parentFlowId: flowId,
  });
}
