// Projects task and task-flow records into domain views for status surfaces.
import type {
  TaskFlowDetail,
  TaskFlowView,
  TaskRunAggregateSummary,
  TaskRunDetail,
  TaskRunView,
} from "../plugins/runtime/task-domain-types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";

/** Maps internal task summary counts to the plugin task-domain view contract. */
export function mapTaskRunAggregateSummary(summary: TaskRegistrySummary): TaskRunAggregateSummary {
  return {
    total: summary.total,
    active: summary.active,
    terminal: summary.terminal,
    failures: summary.failures,
    byStatus: { ...summary.byStatus },
    byRuntime: { ...summary.byRuntime },
  };
}

export function mapTaskRunView(task: TaskRecord): TaskRunView {
  return {
    id: task.taskId,
    runtime: task.runtime,
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    sessionKey: task.requesterSessionKey,
    ownerKey: task.ownerKey,
    scope: task.scopeKind,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ...(task.parentFlowId ? { flowId: task.parentFlowId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.label ? { label: task.label } : {}),
    title: task.task,
    status: task.status,
    deliveryStatus: task.deliveryStatus,
    notifyPolicy: task.notifyPolicy,
    createdAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.lastEventAt !== undefined ? { lastEventAt: task.lastEventAt } : {}),
    ...(task.cleanupAfter !== undefined ? { cleanupAfter: task.cleanupAfter } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
    ...(task.terminalOutcome ? { terminalOutcome: task.terminalOutcome } : {}),
  };
}

export function mapTaskRunDetail(task: TaskRecord): TaskRunDetail {
  return mapTaskRunView(task);
}

export function mapTaskFlowView(flow: TaskFlowRecord): TaskFlowView {
  return {
    id: flow.flowId,
    ownerKey: flow.ownerKey,
    ...(flow.requesterOrigin ? { requesterOrigin: { ...flow.requesterOrigin } } : {}),
    status: flow.status,
    notifyPolicy: flow.notifyPolicy,
    goal: flow.goal,
    ...(flow.currentStep ? { currentStep: flow.currentStep } : {}),
    ...(flow.cancelRequestedAt !== undefined ? { cancelRequestedAt: flow.cancelRequestedAt } : {}),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...(flow.endedAt !== undefined ? { endedAt: flow.endedAt } : {}),
  };
}

export function mapTaskFlowDetail(params: {
  flow: TaskFlowRecord;
  tasks: TaskRecord[];
  summary?: TaskRegistrySummary;
}): TaskFlowDetail {
  const summary = params.summary ?? summarizeTaskRecords(params.tasks);
  const base = mapTaskFlowView(params.flow);
  return {
    ...base,
    ...(params.flow.stateJson !== undefined ? { state: params.flow.stateJson } : {}),
    ...(params.flow.waitJson !== undefined ? { wait: params.flow.waitJson } : {}),
    ...(params.flow.blockedTaskId || params.flow.blockedSummary
      ? {
          blocked: {
            ...(params.flow.blockedTaskId ? { taskId: params.flow.blockedTaskId } : {}),
            ...(params.flow.blockedSummary ? { summary: params.flow.blockedSummary } : {}),
          },
        }
      : {}),
    tasks: params.tasks.map((task) => mapTaskRunView(task)),
    taskSummary: mapTaskRunAggregateSummary(summary),
  };
}
