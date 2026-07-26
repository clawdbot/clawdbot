import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import {
  assertParentFlowLinkAllowed,
  ensureLinkedTaskFlowRegistryReady,
  ensureNotifyPolicy,
} from "./task-registry-common.js";
import { updateTask, upsertTaskDeliveryState } from "./task-registry-mutation.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import {
  getTasksByRunId,
  pickPreferredRunIdTask,
  taskDeliveryStates,
} from "./task-registry-state.js";
import type {
  JsonValue,
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
} from "./task-registry.types.js";

export function findExistingTaskForCreate(params: {
  runtime: TaskRuntime;
  ownerKey: string;
  scopeKind: TaskScopeKind;
  childSessionKey?: string;
  parentFlowId?: string;
  runId?: string;
  label?: string;
  task: string;
}): TaskRecord | undefined {
  const runId = params.runId?.trim();
  const runScopeMatches = runId
    ? getTasksByRunId(runId).filter((task) => {
        if (
          task.runtime !== params.runtime ||
          task.scopeKind !== params.scopeKind ||
          (normalizeOptionalString(task.ownerKey) ?? "") !==
            (normalizeOptionalString(params.ownerKey) ?? "") ||
          (normalizeOptionalString(task.childSessionKey) ?? "") !==
            (normalizeOptionalString(params.childSessionKey) ?? "")
        ) {
          return false;
        }
        if (params.runtime === "acp") {
          // ACP one-task flow ids can be derived after creation; they must not
          // split one logical ACP run into duplicate task rows.
          return true;
        }
        return (
          (normalizeOptionalString(task.parentFlowId) ?? "") ===
          (normalizeOptionalString(params.parentFlowId) ?? "")
        );
      })
    : [];
  const exact = runId
    ? runScopeMatches.find(
        (task) =>
          (normalizeOptionalString(task.label) ?? "") ===
            (normalizeOptionalString(params.label) ?? "") &&
          (normalizeOptionalString(task.task) ?? "") ===
            (normalizeOptionalString(params.task) ?? ""),
      )
    : undefined;
  if (exact) {
    return exact;
  }
  if (!runId || params.runtime !== "acp") {
    return undefined;
  }
  if (runScopeMatches.length === 0) {
    return undefined;
  }
  return pickPreferredRunIdTask(runScopeMatches);
}

export function mergeExistingTaskForCreate(
  existing: TaskRecord,
  params: {
    taskKind?: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
    sourceId?: string;
    parentFlowId?: string;
    parentTaskId?: string;
    agentId?: string;
    requesterAgentId?: string;
    label?: string;
    task: string;
    preferMetadata?: boolean;
    deliveryStatus?: TaskDeliveryStatus;
    notifyPolicy?: TaskNotifyPolicy;
    detail?: JsonValue;
  },
): TaskRecord | null {
  ensureLinkedTaskFlowRegistryReady(existing);
  const patch: Partial<TaskRecord> = {};
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const currentDeliveryState = taskDeliveryStates.get(existing.taskId);
  if (requesterOrigin && !currentDeliveryState?.requesterOrigin) {
    const deliveryState = upsertTaskDeliveryState({
      taskId: existing.taskId,
      requesterOrigin,
      lastNotifiedEventAt: currentDeliveryState?.lastNotifiedEventAt,
    });
    if (!deliveryState.requesterOrigin) {
      return null;
    }
  }
  if (params.sourceId?.trim() && !existing.sourceId?.trim()) {
    patch.sourceId = params.sourceId.trim();
  }
  if (params.taskKind?.trim() && !existing.taskKind?.trim()) {
    patch.taskKind = params.taskKind.trim();
  }
  if (params.parentFlowId?.trim() && !existing.parentFlowId?.trim()) {
    assertParentFlowLinkAllowed({
      ownerKey: existing.ownerKey,
      scopeKind: existing.scopeKind,
      parentFlowId: params.parentFlowId,
    });
    patch.parentFlowId = params.parentFlowId.trim();
  }
  if (params.parentTaskId?.trim() && !existing.parentTaskId?.trim()) {
    patch.parentTaskId = params.parentTaskId.trim();
  }
  if (params.agentId?.trim() && !existing.agentId?.trim()) {
    patch.agentId = params.agentId.trim();
  }
  if (params.requesterAgentId?.trim() && !existing.requesterAgentId?.trim()) {
    patch.requesterAgentId = params.requesterAgentId.trim();
  }
  const nextLabel = params.label?.trim();
  if (params.preferMetadata) {
    if (nextLabel && (normalizeOptionalString(existing.label) ?? "") !== nextLabel) {
      patch.label = nextLabel;
    }
    const nextTask = params.task.trim();
    if (nextTask && (normalizeOptionalString(existing.task) ?? "") !== nextTask) {
      patch.task = nextTask;
    }
  } else if (nextLabel && !existing.label?.trim()) {
    patch.label = nextLabel;
  }
  if (params.deliveryStatus === "pending" && existing.deliveryStatus !== "delivered") {
    patch.deliveryStatus = "pending";
  }
  const notifyPolicy = ensureNotifyPolicy({
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus,
    ownerKey: existing.ownerKey,
    scopeKind: existing.scopeKind,
  });
  if (notifyPolicy !== existing.notifyPolicy && existing.notifyPolicy === "silent") {
    patch.notifyPolicy = notifyPolicy;
  }
  if (params.detail !== undefined) {
    patch.detail = params.detail;
  }
  if (Object.keys(patch).length === 0) {
    return cloneTaskRecord(existing);
  }
  return updateTask(existing.taskId, patch);
}

export function resolveTaskAgentId(params: {
  explicitAgentId?: string;
  childSessionKey?: string;
  ownerKey: string;
  requesterSessionKey: string;
}): string | undefined {
  return (
    normalizeOptionalString(params.explicitAgentId) ??
    parseAgentSessionKey(params.childSessionKey)?.agentId ??
    parseAgentSessionKey(params.ownerKey)?.agentId ??
    parseAgentSessionKey(params.requesterSessionKey)?.agentId
  );
}

export function resolveTaskRequesterAgentId(params: {
  explicitRequesterAgentId?: string;
  ownerKey: string;
  requesterSessionKey: string;
}): string | undefined {
  const explicitRequesterAgentId = normalizeOptionalString(params.explicitRequesterAgentId);
  return (
    (explicitRequesterAgentId ? normalizeAgentId(explicitRequesterAgentId) : undefined) ??
    parseAgentSessionKey(params.ownerKey)?.agentId ??
    parseAgentSessionKey(params.requesterSessionKey)?.agentId
  );
}
