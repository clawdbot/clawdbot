import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import {
  getTaskFlowById,
  syncFlowFromTaskResult,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import { ensureLinkedTaskFlowRegistryReady, isTerminalFlowStatus } from "./task-registry-common.js";
import { findLatestTaskForFlowId, listTasksForFlowId } from "./task-registry-query.js";
import {
  cloneTaskDeliveryState,
  cloneTaskRecord,
  normalizeTaskTimestamps,
} from "./task-registry-records.js";
import {
  addOwnerKeyIndex,
  addParentFlowIdIndex,
  addRelatedSessionKeyIndex,
  deleteOwnerKeyIndex,
  deleteParentFlowIdIndex,
  deleteRelatedSessionKeyIndex,
  emitTaskRegistryObserverEvent,
  log,
  rebuildRunIdIndex,
  taskDeliveryStates,
  taskFlowSyncRetryTimers,
  tasks,
  TASK_FLOW_SYNC_RETRY_DELAYS_MS,
  tryPersistTaskDeliveryStateUpsert,
  tryPersistTaskUpsert,
} from "./task-registry-state.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";
import { resolveTaskCleanupAfter } from "./task-retention.js";

function syncManagedFlowCancellationFromTask(task: TaskRecord): void {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  let flow = getTaskFlowById(flowId);
  if (
    !flow ||
    flow.syncMode !== "managed" ||
    flow.cancelRequestedAt == null ||
    isTerminalFlowStatus(flow.status)
  ) {
    return;
  }
  if (listTasksForFlowId(flowId).some(isTaskFlowCancellationPending)) {
    return;
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = updateFlowRecordByIdExpectedRevision({
      flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "cancelled",
        blockedTaskId: null,
        blockedSummary: null,
        waitJson: null,
        endedAt,
        updatedAt: endedAt,
      },
    });
    if (result.applied || result.reason === "not_found") {
      return;
    }
    flow = result.current;
    if (
      !flow ||
      flow.syncMode !== "managed" ||
      flow.cancelRequestedAt == null ||
      isTerminalFlowStatus(flow.status)
    ) {
      return;
    }
    if (listTasksForFlowId(flowId).some(isTaskFlowCancellationPending)) {
      return;
    }
  }
}

function scheduleTaskFlowSyncRetry(task: TaskRecord, operation: string, attempt = 0): void {
  const taskId = task.taskId.trim();
  if (!taskId || taskFlowSyncRetryTimers.has(taskId)) {
    return;
  }
  const delayMs = TASK_FLOW_SYNC_RETRY_DELAYS_MS[attempt];
  if (delayMs == null) {
    log.warn("Exhausted parent flow sync retries from task", {
      operation,
      taskId,
      flowId: task.parentFlowId,
    });
    return;
  }
  const retryTimer = setTimeout(() => {
    taskFlowSyncRetryTimers.delete(taskId);
    // A terminal task no longer blocks suspension, but its durable parent-flow
    // projection still mutates state. Keep every delayed attempt visible and
    // prevent it from crossing a prepared host snapshot boundary.
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      const current = tasks.get(taskId);
      if (!current) {
        return;
      }
      const flowId = current.parentFlowId?.trim();
      if (!flowId || findLatestTaskForFlowId(flowId)?.taskId !== taskId) {
        return;
      }
      const result = syncFlowFromTaskResult(current);
      if (!result.ok) {
        log.warn("Failed to retry parent flow sync from task", {
          operation,
          taskId,
          flowId: current.parentFlowId,
          reason: result.reason,
        });
        scheduleTaskFlowSyncRetry(current, operation, attempt + 1);
      }
    }).catch((error: unknown) => {
      log.warn("Failed to admit parent flow sync retry from task", {
        operation,
        taskId,
        flowId: task.parentFlowId,
        error,
      });
    });
  }, delayMs);
  retryTimer.unref?.();
  taskFlowSyncRetryTimers.set(taskId, retryTimer);
}

export function syncFlowFromTaskAfterTaskMutation(task: TaskRecord, operation: string): void {
  const result = syncFlowFromTaskResult(task);
  if (result.ok) {
    return;
  }
  log.warn("Failed to sync parent flow from task mutation", {
    operation,
    taskId: task.taskId,
    flowId: task.parentFlowId,
    reason: result.reason,
  });
  scheduleTaskFlowSyncRetry(task, operation);
}

export function updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
  const current = tasks.get(taskId);
  if (!current) {
    return null;
  }
  const next = normalizeTaskTimestamps({
    ...current,
    ...patch,
    ...(patch.detail !== undefined ? { detail: structuredClone(patch.detail) } : {}),
  });
  if (Object.hasOwn(patch, "error") && patch.error === undefined) {
    delete next.error;
  }
  if (Object.hasOwn(patch, "childSessionKey") && patch.childSessionKey === undefined) {
    delete next.childSessionKey;
  }
  if (isTerminalTaskStatus(next.status) && typeof next.cleanupAfter !== "number") {
    const createdAt = next.createdAt ?? Date.now();
    const cleanupAfter = resolveTaskCleanupAfter({ ...next, createdAt });
    Object.assign(next, cleanupAfter === undefined ? {} : { cleanupAfter });
  }
  const sessionIndexChanged =
    normalizeOptionalString(current.ownerKey) !== normalizeOptionalString(next.ownerKey) ||
    normalizeOptionalString(current.childSessionKey) !==
      normalizeOptionalString(next.childSessionKey);
  const parentFlowIndexChanged = current.parentFlowId?.trim() !== next.parentFlowId?.trim();
  ensureLinkedTaskFlowRegistryReady(current);
  ensureLinkedTaskFlowRegistryReady(next);
  // Persist before mutating memory. If the store rejects the write, keep the
  // in-memory mirror at the durable value and report that no mutation applied.
  if (!tryPersistTaskUpsert(next, "update")) {
    return null;
  }
  tasks.set(taskId, next);
  if (patch.runId && patch.runId !== current.runId) {
    rebuildRunIdIndex();
  }
  if (sessionIndexChanged) {
    deleteOwnerKeyIndex(taskId, current);
    addOwnerKeyIndex(taskId, next);
    deleteRelatedSessionKeyIndex(taskId, current);
    addRelatedSessionKeyIndex(taskId, next);
  }
  if (parentFlowIndexChanged) {
    deleteParentFlowIdIndex(taskId, current);
    addParentFlowIdIndex(taskId, next);
  }
  syncFlowFromTaskAfterTaskMutation(next, "update");
  try {
    syncManagedFlowCancellationFromTask(next);
  } catch (error) {
    log.warn("Failed to finalize managed flow cancellation from task update", {
      taskId,
      flowId: next.parentFlowId,
      error,
    });
  }
  emitTaskRegistryObserverEvent(() => ({
    kind: "upserted",
    task: cloneTaskRecord(next),
    previous: cloneTaskRecord(current),
  }));
  return cloneTaskRecord(next);
}

export function upsertTaskDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  const current = taskDeliveryStates.get(state.taskId);
  const next: TaskDeliveryState = {
    taskId: state.taskId,
    ...(state.requesterOrigin
      ? { requesterOrigin: normalizeDeliveryContext(state.requesterOrigin) }
      : {}),
    ...(state.lastNotifiedEventAt != null
      ? { lastNotifiedEventAt: state.lastNotifiedEventAt }
      : {}),
  };
  if (!next.requesterOrigin && typeof next.lastNotifiedEventAt !== "number" && !current) {
    return cloneTaskDeliveryState({ taskId: state.taskId });
  }
  if (!tryPersistTaskDeliveryStateUpsert(next)) {
    return current
      ? cloneTaskDeliveryState(current)
      : cloneTaskDeliveryState({ taskId: state.taskId });
  }
  taskDeliveryStates.set(state.taskId, next);
  return cloneTaskDeliveryState(next);
}

export function getTaskDeliveryState(taskId: string): TaskDeliveryState | undefined {
  const state = taskDeliveryStates.get(taskId);
  return state ? cloneTaskDeliveryState(state) : undefined;
}
