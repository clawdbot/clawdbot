// Executes task records through configured runtimes and updates registry state.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  DetachedRunningTaskCreateParams,
  DetachedTaskCompleteParams,
  DetachedTaskCreateParams,
  DetachedTaskFailParams,
  DetachedTaskFinalizeParams,
} from "./detached-task-runtime-contract.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "./detached-task-runtime-state.js";
import {
  assertTaskCancellationReadyById,
  cancelTaskById,
  createTaskRecord,
  findTaskByRunId as findTaskByRunIdInRegistry,
  getTaskById,
  isParentFlowLinkError,
  linkTaskToFlowById,
  listTaskRecordsUnsorted as listTaskRecordsUnsortedInRegistry,
  listTasksForFlowId,
  markTaskTerminalById as markTaskTerminalByIdInRegistry,
  markTaskRunningByRunId,
  finalizeTaskRunByRunId as finalizeTaskRunByRunIdInRegistry,
  recordTaskProgressByRunId,
  setTaskRunDeliveryStatusByRunId,
} from "./runtime-internal.js";
import {
  isProvisionalSubagentKillTask,
  isTaskFlowCancellationPending,
} from "./task-cancellation-state.js";
import { getTaskFlowByIdForOwner } from "./task-flow-owner-access.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createTaskFlowForTask,
  deleteTaskFlowRecordById,
  getTaskFlowById,
  requestFlowCancel,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistrySummary,
  TaskRuntime,
} from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/executor");

// One-task flows give detached ACP/subagent runs a flow handle for status and retry surfaces.
function isOneTaskFlowEligible(task: TaskRecord): boolean {
  if (task.parentFlowId?.trim() || task.scopeKind !== "session") {
    return false;
  }
  if (task.deliveryStatus === "not_applicable") {
    return false;
  }
  return task.runtime === "acp" || task.runtime === "subagent";
}

function ensureSingleTaskFlow(params: {
  task: TaskRecord;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
}): TaskRecord {
  if (!isOneTaskFlowEligible(params.task)) {
    return params.task;
  }
  try {
    const flow = createTaskFlowForTask({
      task: params.task,
      requesterOrigin: params.requesterOrigin,
    });
    if (!flow) {
      return params.task;
    }
    const linked = linkTaskToFlowById({
      taskId: params.task.taskId,
      flowId: flow.flowId,
    });
    if (!linked) {
      deleteTaskFlowRecordById(flow.flowId);
      return params.task;
    }
    if (linked.parentFlowId !== flow.flowId) {
      deleteTaskFlowRecordById(flow.flowId);
      return linked;
    }
    return linked;
  } catch (error) {
    log.warn("Failed to create one-task flow for detached run", {
      taskId: params.task.taskId,
      runId: params.task.runId,
      error,
    });
    return params.task;
  }
}

export function createQueuedTaskRun(params: DetachedTaskCreateParams): TaskRecord | null {
  const task = createTaskRecord({
    ...params,
    status: "queued",
  });
  if (!task) {
    return null;
  }
  return ensureSingleTaskFlow({
    task,
    requesterOrigin: params.requesterOrigin,
  });
}

export function getFlowTaskSummary(flowId: string): TaskRegistrySummary {
  return summarizeTaskRecords(listTasksForFlowId(flowId));
}

export function createRunningTaskRun(params: DetachedRunningTaskCreateParams): TaskRecord | null {
  const task = createTaskRecord({
    ...params,
    status: "running",
  });
  if (!task) {
    return null;
  }
  return ensureSingleTaskFlow({
    task,
    requesterOrigin: params.requesterOrigin,
  });
}

export function findTaskByRunId(runId: string): TaskRecord | undefined {
  return findTaskByRunIdInRegistry(runId);
}

export function listTaskRecordsUnsorted(): TaskRecord[] {
  return listTaskRecordsUnsortedInRegistry();
}

type RunTaskInFlowParams = {
  flowId: string;
  runtime: TaskRuntime;
  sourceId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  preferMetadata?: boolean;
  status?: "queued" | "running";
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
};

export function startTaskRunByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return markTaskRunningByRunId(params);
}

export function recordTaskRunProgressByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  lastEventAt?: number;
  progressSummary?: string | null;
  eventSummary?: string | null;
}) {
  return recordTaskProgressByRunId(params);
}

export function completeTaskRunByRunId(params: DetachedTaskCompleteParams) {
  return finalizeTaskRunByRunId({
    ...params,
    status: "succeeded",
  });
}

export function finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams) {
  return finalizeTaskRunByRunIdInRegistry(params);
}

export function finalizeTaskRunById(
  params: Parameters<typeof markTaskTerminalByIdInRegistry>[0],
): TaskRecord | null {
  return markTaskTerminalByIdInRegistry(params);
}

export function failTaskRunByRunId(params: DetachedTaskFailParams) {
  return finalizeTaskRunByRunId({
    ...params,
    status: params.status ?? "failed",
  });
}

export function setDetachedTaskDeliveryStatusByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  deliveryStatus: TaskDeliveryStatus;
  error?: string;
}) {
  return setTaskRunDeliveryStatusByRunId(params);
}

type CancelFlowResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
};

type RunTaskInFlowResult = {
  found: boolean;
  created: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  task?: TaskRecord;
};

function isTerminalFlowStatus(status: TaskFlowRecord["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function markFlowCancelRequested(flow: TaskFlowRecord): TaskFlowRecord | FlowUpdateFailure {
  if (flow.cancelRequestedAt != null) {
    return flow;
  }
  const result = requestFlowCancel({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  });
  if (result.applied) {
    return result.flow;
  }
  return {
    reason: describeFlowUpdateFailure(result.reason),
    flow: result.current ?? getTaskFlowById(flow.flowId),
  };
}

type FlowUpdateFailure = {
  reason: string;
  flow?: TaskFlowRecord;
};

function describeFlowUpdateFailure(
  reason: Exclude<ReturnType<typeof requestFlowCancel>, { applied: true }>["reason"],
): string {
  switch (reason) {
    case "revision_conflict":
      return "Flow changed while cancellation was in progress.";
    case "persist_failed":
      return "Flow persistence failed.";
    case "not_found":
      return "Flow not found.";
    default:
      return "Flow mutation failed.";
  }
}

function cancelManagedFlowAfterChildrenSettle(
  flow: TaskFlowRecord,
  endedAt: number,
): TaskFlowRecord | FlowUpdateFailure {
  const result = updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
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
  if (result.applied) {
    return result.flow;
  }
  return {
    reason: describeFlowUpdateFailure(result.reason),
    flow: result.current ?? getTaskFlowById(flow.flowId),
  };
}

function mapRunTaskInFlowCreateError(params: {
  error: unknown;
  flowId: string;
}): RunTaskInFlowResult {
  const flow = getTaskFlowById(params.flowId);
  if (isParentFlowLinkError(params.error)) {
    if (params.error.code === "cancel_requested") {
      return {
        found: true,
        created: false,
        reason: "Flow cancellation has already been requested.",
        ...(flow ? { flow } : {}),
      };
    }
    if (params.error.code === "terminal") {
      const terminalStatus = flow?.status ?? params.error.details?.status ?? "terminal";
      return {
        found: true,
        created: false,
        reason: `Flow is already ${terminalStatus}.`,
        ...(flow ? { flow } : {}),
      };
    }
    if (params.error.code === "parent_flow_not_found") {
      return {
        found: false,
        created: false,
        reason: "Flow not found.",
      };
    }
  }
  throw params.error;
}

function runTaskInFlow(params: RunTaskInFlowParams): RunTaskInFlowResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      created: false,
      reason: "Flow not found.",
    };
  }
  if (flow.syncMode !== "managed") {
    return {
      found: true,
      created: false,
      reason: "Flow does not accept managed child tasks.",
      flow,
    };
  }
  if (flow.cancelRequestedAt != null) {
    return {
      found: true,
      created: false,
      reason: "Flow cancellation has already been requested.",
      flow,
    };
  }
  if (isTerminalFlowStatus(flow.status)) {
    return {
      found: true,
      created: false,
      reason: `Flow is already ${flow.status}.`,
      flow,
    };
  }

  const common = {
    runtime: params.runtime,
    sourceId: params.sourceId,
    ownerKey: flow.ownerKey,
    scopeKind: "session" as const,
    requesterOrigin: flow.requesterOrigin,
    parentFlowId: flow.flowId,
    childSessionKey: params.childSessionKey,
    parentTaskId: params.parentTaskId,
    agentId: params.agentId,
    runId: params.runId,
    label: params.label,
    task: params.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus ?? "pending",
  };
  let task: TaskRecord | null;
  try {
    task =
      params.status === "running"
        ? createRunningTaskRun({
            ...common,
            startedAt: params.startedAt,
            lastEventAt: params.lastEventAt,
            progressSummary: params.progressSummary,
          })
        : createQueuedTaskRun(common);
  } catch (error) {
    return mapRunTaskInFlowCreateError({
      error,
      flowId: flow.flowId,
    });
  }
  if (!task) {
    return {
      found: true,
      created: false,
      reason: "Task persistence failed.",
      flow: getTaskFlowById(flow.flowId) ?? flow,
    };
  }
  const registeredTask = getTaskById(task.taskId);
  if (!registeredTask) {
    return {
      found: true,
      created: false,
      reason: "Task persistence failed.",
      flow: getTaskFlowById(flow.flowId) ?? flow,
    };
  }

  return {
    found: true,
    created: true,
    flow: getTaskFlowById(flow.flowId) ?? flow,
    task: registeredTask,
  };
}

export function runTaskInFlowForOwner(
  params: RunTaskInFlowParams & { callerOwnerKey: string },
): RunTaskInFlowResult {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow) {
    return {
      found: false,
      created: false,
      reason: "Flow not found.",
    };
  }
  return runTaskInFlow({
    flowId: flow.flowId,
    runtime: params.runtime,
    sourceId: params.sourceId,
    childSessionKey: params.childSessionKey,
    parentTaskId: params.parentTaskId,
    agentId: params.agentId,
    runId: params.runId,
    label: params.label,
    task: params.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus,
    status: params.status,
    startedAt: params.startedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
  });
}

export async function cancelFlowById(params: {
  cfg: OpenClawConfig;
  flowId: string;
}): Promise<CancelFlowResult> {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      found: false,
      cancelled: false,
      reason: "Flow not found.",
    };
  }
  if (isTerminalFlowStatus(flow.status)) {
    const provisionalTasks = listTasksForFlowId(flow.flowId).filter(isProvisionalSubagentKillTask);
    if (flow.status === "cancelled" && provisionalTasks.length > 0) {
      for (const task of provisionalTasks) {
        await cancelDetachedTaskRunById({ cfg: params.cfg, taskId: task.taskId });
      }
      const tasks = listTasksForFlowId(flow.flowId);
      if (tasks.some(isProvisionalSubagentKillTask)) {
        return {
          found: true,
          cancelled: false,
          reason: "One or more child tasks remain provisionally cancelled.",
          flow: getTaskFlowById(flow.flowId) ?? flow,
          tasks,
        };
      }
      const refreshedFlow = getTaskFlowById(flow.flowId) ?? flow;
      return {
        found: true,
        cancelled: refreshedFlow.status === "cancelled",
        reason:
          refreshedFlow.status === "cancelled"
            ? undefined
            : `Flow is already ${refreshedFlow.status}.`,
        flow: refreshedFlow,
        tasks,
      };
    }
    return {
      found: true,
      cancelled: false,
      reason: `Flow is already ${flow.status}.`,
      flow,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const cancelRequestedFlow = markFlowCancelRequested(flow);
  if ("reason" in cancelRequestedFlow) {
    return {
      found: true,
      cancelled: false,
      reason: cancelRequestedFlow.reason,
      flow: cancelRequestedFlow.flow,
      tasks: listTasksForFlowId(flow.flowId),
    };
  }
  const linkedTasks = listTasksForFlowId(flow.flowId);
  const activeTasks = linkedTasks.filter(isTaskFlowCancellationPending);
  for (const task of activeTasks) {
    await cancelDetachedTaskRunById({
      cfg: params.cfg,
      taskId: task.taskId,
    });
  }
  const refreshedTasks = listTasksForFlowId(flow.flowId);
  const remainingActive = refreshedTasks.filter(isTaskFlowCancellationPending);
  if (remainingActive.length > 0) {
    return {
      found: true,
      cancelled: false,
      reason: "One or more child tasks are still active.",
      flow: getTaskFlowById(flow.flowId) ?? cancelRequestedFlow,
      tasks: refreshedTasks,
    };
  }
  const now = Date.now();
  const refreshedFlow = getTaskFlowById(flow.flowId) ?? cancelRequestedFlow;
  if (isTerminalFlowStatus(refreshedFlow.status)) {
    return {
      found: true,
      cancelled: refreshedFlow.status === "cancelled",
      reason:
        refreshedFlow.status === "cancelled"
          ? undefined
          : `Flow is already ${refreshedFlow.status}.`,
      flow: refreshedFlow,
      tasks: refreshedTasks,
    };
  }
  const updatedFlow = cancelManagedFlowAfterChildrenSettle(refreshedFlow, now);
  if ("reason" in updatedFlow) {
    return {
      found: true,
      cancelled: false,
      reason: updatedFlow.reason,
      flow: updatedFlow.flow,
      tasks: refreshedTasks,
    };
  }
  return {
    found: true,
    cancelled: true,
    flow: updatedFlow,
    tasks: refreshedTasks,
  };
}

export async function cancelFlowByIdForOwner(params: {
  cfg: OpenClawConfig;
  flowId: string;
  callerOwnerKey: string;
}): Promise<CancelFlowResult> {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!flow) {
    return {
      found: false,
      cancelled: false,
      reason: "Flow not found.",
    };
  }
  return cancelFlowById({
    cfg: params.cfg,
    flowId: flow.flowId,
  });
}

export async function cancelDetachedTaskRunById(params: {
  cfg: OpenClawConfig;
  taskId: string;
  reason?: string;
}) {
  const task = getTaskById(params.taskId);
  const registeredRuntime = getRegisteredDetachedTaskLifecycleRuntime();
  if (!task) {
    if (registeredRuntime) {
      const cancelled = await registeredRuntime.cancelDetachedTaskRunById(params);
      if (cancelled.found) {
        return cancelled;
      }
    }
    return cancelTaskById(params);
  }
  try {
    assertTaskCancellationReadyById(task.taskId);
  } catch (error) {
    return {
      found: true,
      cancelled: false,
      reason: formatErrorMessage(error),
      task,
    };
  }
  if (registeredRuntime) {
    const cancelled = await registeredRuntime.cancelDetachedTaskRunById(params);
    if (cancelled.found) {
      return cancelled;
    }
  }
  return cancelTaskById(params);
}
