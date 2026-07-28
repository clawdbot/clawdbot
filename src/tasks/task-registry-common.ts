import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { ensureTaskFlowRegistryReady, getTaskFlowById } from "./task-flow-runtime-internal.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskEventKind,
  TaskEventRecord,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
  TaskStatus,
  TaskTerminalOutcome,
} from "./task-registry.types.js";

export type TaskDeliveryOwner = {
  sessionKey?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  flowId?: string;
};

type ParentFlowLinkErrorCode =
  | "scope_kind_not_session"
  | "parent_flow_not_found"
  | "owner_key_mismatch"
  | "cancel_requested"
  | "terminal";

class ParentFlowLinkError extends Error {
  constructor(
    public readonly code: ParentFlowLinkErrorCode,
    message: string,
    public readonly details?: {
      flowId?: string;
      status?: TaskFlowRecord["status"];
    },
  ) {
    super(message);
    this.name = "ParentFlowLinkError";
  }
}

export function isParentFlowLinkError(error: unknown): error is ParentFlowLinkError {
  return error instanceof ParentFlowLinkError;
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

export function isTerminalFlowStatus(status: TaskFlowRecord["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

export function assertTaskOwner(params: { ownerKey: string; scopeKind: TaskScopeKind }) {
  const ownerKey = params.ownerKey.trim();
  if (!ownerKey && params.scopeKind !== "system") {
    throw new Error("Task ownerKey is required.");
  }
}

export function assertParentFlowLinkAllowed(params: {
  ownerKey: string;
  scopeKind: TaskScopeKind;
  parentFlowId?: string;
}) {
  const flowId = params.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  if (params.scopeKind !== "session") {
    throw new ParentFlowLinkError(
      "scope_kind_not_session",
      "Only session-scoped tasks can link to flows.",
      { flowId },
    );
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    throw new ParentFlowLinkError("parent_flow_not_found", `Parent flow not found: ${flowId}`, {
      flowId,
    });
  }
  if (normalizeOptionalString(flow.ownerKey) !== normalizeOptionalString(params.ownerKey)) {
    throw new ParentFlowLinkError(
      "owner_key_mismatch",
      "Task ownerKey must match parent flow ownerKey.",
      { flowId },
    );
  }
  if (flow.cancelRequestedAt != null) {
    throw new ParentFlowLinkError(
      "cancel_requested",
      "Parent flow cancellation has already been requested.",
      { flowId, status: flow.status },
    );
  }
  if (isTerminalFlowStatus(flow.status)) {
    throw new ParentFlowLinkError("terminal", `Parent flow is already ${flow.status}.`, {
      flowId,
      status: flow.status,
    });
  }
}

export function ensureLinkedTaskFlowRegistryReady(task: Pick<TaskRecord, "parentFlowId">): void {
  if (task.parentFlowId?.trim()) {
    ensureTaskFlowRegistryReady();
  }
}

export function ensureDeliveryStatus(params: {
  ownerKey: string;
  scopeKind: TaskScopeKind;
}): TaskDeliveryStatus {
  if (params.scopeKind === "system") {
    return "not_applicable";
  }
  return params.ownerKey.trim() ? "pending" : "parent_missing";
}

export function ensureNotifyPolicy(params: {
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  ownerKey: string;
  scopeKind: TaskScopeKind;
}): TaskNotifyPolicy {
  if (params.notifyPolicy) {
    return params.notifyPolicy;
  }
  const deliveryStatus =
    params.deliveryStatus ??
    ensureDeliveryStatus({
      ownerKey: params.ownerKey,
      scopeKind: params.scopeKind,
    });
  return deliveryStatus === "not_applicable" ? "silent" : "done_only";
}

export function resolveTaskScopeKind(params: {
  scopeKind?: TaskScopeKind;
  requesterSessionKey: string;
}): TaskScopeKind {
  if (params.scopeKind) {
    return params.scopeKind;
  }
  return params.requesterSessionKey.trim() ? "session" : "system";
}

export function resolveTaskRequesterSessionKey(params: {
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: TaskScopeKind;
}): string {
  const requesterSessionKey = params.requesterSessionKey?.trim();
  if (requesterSessionKey) {
    return requesterSessionKey;
  }
  if (params.scopeKind === "system") {
    return "";
  }
  return params.ownerKey?.trim() ?? "";
}

export function resolveTaskOwnerKey(params: {
  requesterSessionKey: string;
  ownerKey?: string;
}): string {
  return params.ownerKey?.trim() || params.requesterSessionKey.trim();
}

export function normalizeTaskSummary(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

export function normalizeTaskStatus(value: TaskStatus | null | undefined): TaskStatus {
  return value === "running" ||
    value === "queued" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "cancelled" ||
    value === "lost"
    ? value
    : "queued";
}

function normalizeTaskTerminalOutcome(
  value: TaskTerminalOutcome | null | undefined,
): TaskTerminalOutcome | undefined {
  return value === "succeeded" || value === "blocked" ? value : undefined;
}

export function shouldApplyRunScopedStatusUpdate(params: {
  currentStatus: TaskStatus;
  currentRuntime: TaskRuntime;
  currentChildSessionKey?: string;
  currentError?: string;
  currentEndedAt?: number;
  nextStatus: TaskStatus;
  nextError?: string;
  nextEndedAt?: number;
}): boolean {
  if (
    params.currentRuntime === "subagent" &&
    params.nextStatus === "cancelled" &&
    params.nextError === SUBAGENT_KILL_TASK_ERROR &&
    isTerminalTaskStatus(params.currentStatus) &&
    !(params.currentStatus === "cancelled" && params.currentError === SUBAGENT_KILL_TASK_ERROR)
  ) {
    // The kill marker is provisional. It may refresh only its own tombstone;
    // canonical completion or operator cancellation already won this race.
    return false;
  }
  if (params.currentStatus === params.nextStatus) {
    return true;
  }
  if (!isTerminalTaskStatus(params.currentStatus)) {
    return true;
  }
  if (!isTerminalTaskStatus(params.nextStatus)) {
    return false;
  }
  // Direct subagent termination is provisional. An operator cancellation is
  // sticky only against outcomes that completed at or after cancellation.
  if (
    params.currentStatus === "cancelled" &&
    (params.nextStatus === "succeeded" ||
      params.nextStatus === "failed" ||
      params.nextStatus === "timed_out")
  ) {
    const canonicalOutcomePredatesCancellation =
      params.currentRuntime === "subagent" &&
      params.currentEndedAt !== undefined &&
      params.nextEndedAt !== undefined &&
      params.nextEndedAt < params.currentEndedAt;
    return (
      canonicalOutcomePredatesCancellation ||
      (params.currentRuntime === "subagent" &&
        Boolean(params.currentChildSessionKey?.trim()) &&
        params.currentError === SUBAGENT_KILL_TASK_ERROR)
    );
  }
  return params.currentStatus === "succeeded" && params.nextStatus !== "lost";
}

export function resolveTaskTerminalOutcome(params: {
  status: TaskStatus;
  terminalOutcome?: TaskTerminalOutcome | null;
}): TaskTerminalOutcome | undefined {
  const normalized = normalizeTaskTerminalOutcome(params.terminalOutcome);
  if (normalized) {
    return normalized;
  }
  return params.status === "succeeded" ? "succeeded" : undefined;
}

export function mapAgentRunTerminalOutcomeToTaskStatus(
  outcome: AgentRunTerminalOutcome,
): Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled"> {
  switch (outcome.reason) {
    case "completed":
      return "succeeded";
    case "hard_timeout":
    case "timed_out":
      return "timed_out";
    case "cancelled":
    case "aborted":
      return "cancelled";
    case "blocked":
    case "abandoned":
    case "failed":
      return "failed";
    default:
      return outcome.reason satisfies never;
  }
}

export function resolveTaskLifecycleTerminalError(params: {
  runtime: TaskRuntime;
  status: TaskStatus;
  error?: string;
}): string | undefined {
  // A runner abort can race either an accepted task cancellation or a real
  // completion. Keep it provisional until the task-control owner decides.
  return params.runtime === "subagent" && params.status === "cancelled"
    ? SUBAGENT_KILL_TASK_ERROR
    : params.error;
}

export function buildTaskLifecycleTerminalOutcome(params: {
  phase: "end" | "error";
  data?: Record<string, unknown>;
  startedAt?: number;
  endedAt?: number;
}): AgentRunTerminalOutcome {
  const status =
    params.phase === "error" ? "error" : params.data?.aborted === true ? "timeout" : "ok";
  // Lifecycle events carry runner/provider terminal facts. Keep the precedence
  // centralized so task projections match agent.wait and gateway snapshots.
  return buildAgentRunTerminalOutcome({
    status,
    error: params.data?.error,
    stopReason: params.data?.stopReason,
    livenessState: params.data?.livenessState,
    timeoutPhase: params.data?.timeoutPhase,
    providerStarted: params.data?.providerStarted,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
  });
}

export function appendTaskEvent(event: {
  at: number;
  kind: TaskEventKind;
  summary?: string | null;
}): TaskEventRecord {
  const summary = normalizeTaskSummary(event.summary);
  return {
    at: event.at,
    kind: event.kind,
    ...(summary ? { summary } : {}),
  };
}
