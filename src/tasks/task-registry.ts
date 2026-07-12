// Coordinates task registry creation, updates, delivery state, and snapshots.
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { shouldRouteCompletionThroughRequesterSession } from "../auto-reply/reply/completion-delivery-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { cancelActiveCronTaskRun } from "./cron-task-cancel.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { isChildlessNativeSubagentTask } from "./native-subagent-task.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import {
  formatTaskBlockedFollowupMessage,
  formatTaskStateChangeMessage,
  formatTaskTerminalMessage,
  isTerminalTaskStatus,
  shouldAutoDeliverTaskStateChange,
  shouldAutoDeliverTaskTerminalUpdate,
  shouldSuppressDuplicateTerminalDelivery,
  shouldUseParentReviewTaskTerminalMessage,
} from "./task-executor-policy.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  getTaskFlowById,
  syncFlowFromTaskResult,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
import {
  getTaskRegistryObservers,
  getTaskRegistryStore,
  resetTaskRegistryRuntimeForTests,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
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
import { resolveTaskCleanupAfter } from "./task-retention.js";

const log = createSubsystemLogger("tasks/registry");
const TASK_FLOW_SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 120_000, 600_000] as const;

const taskRegistryProcessState = getTaskRegistryProcessState();
const tasks = taskRegistryProcessState.tasks;
const taskDeliveryStates = taskRegistryProcessState.taskDeliveryStates;
const taskIdsByRunId = taskRegistryProcessState.taskIdsByRunId;
const taskIdsByOwnerKey = taskRegistryProcessState.taskIdsByOwnerKey;
const taskIdsByParentFlowId = taskRegistryProcessState.taskIdsByParentFlowId;
const taskIdsByRelatedSessionKey = taskRegistryProcessState.taskIdsByRelatedSessionKey;
const tasksWithPendingDelivery = taskRegistryProcessState.tasksWithPendingDelivery;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
let restoreAttempted = false;
const taskFlowSyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
type TaskRegistryDeliveryRuntime = Pick<
  typeof import("./task-registry-delivery-runtime.js"),
  "sendMessage"
>;
const TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY = Symbol.for(
  "openclaw.taskRegistry.deliveryRuntimeOverride",
);
const TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY = Symbol.for(
  "openclaw.taskRegistry.controlRuntimeOverride",
);
const require = createRequire(import.meta.url);
const TASK_REGISTRY_CONTROL_RUNTIME_CANDIDATES = [
  "./task-registry-control.runtime.js",
  "./task-registry-control.runtime.ts",
] as const;
type TaskRegistryGlobalWithRuntimeOverrides = typeof globalThis & {
  [TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY]?: TaskRegistryDeliveryRuntime | null;
  [TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY]?: TaskRegistryControlRuntime | null;
};
const deliveryRuntimeLoader = createLazyPromiseLoader(
  () => import("./task-registry-delivery-runtime.js"),
  { cacheRejections: true },
);
const controlRuntimeLoader = createLazyPromiseLoader(
  () =>
    Promise.resolve().then(() => {
      for (const candidate of TASK_REGISTRY_CONTROL_RUNTIME_CANDIDATES) {
        try {
          return require(candidate) as TaskRegistryControlRuntime;
        } catch {
          // Try runtime/source candidates in order.
        }
      }
      throw new Error("Failed to load task registry control runtime.");
    }),
  { cacheRejections: true },
);

type TaskDeliveryOwner = {
  sessionKey?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  flowId?: string;
};

export type ParentFlowLinkErrorCode =
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

function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

function isTerminalFlowStatus(status: TaskFlowRecord["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function assertTaskOwner(params: { ownerKey: string; scopeKind: TaskScopeKind }) {
  const ownerKey = params.ownerKey.trim();
  if (!ownerKey && params.scopeKind !== "system") {
    throw new Error("Task ownerKey is required.");
  }
}

function assertParentFlowLinkAllowed(params: {
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

function cloneTaskRecord(record: TaskRecord): TaskRecord {
  return { ...record };
}

function normalizeTaskTimestamps(task: TaskRecord): TaskRecord {
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
  const lastEventAt =
    typeof task.lastEventAt === "number"
      ? Math.max(task.lastEventAt, startedAt ?? createdAt)
      : task.lastEventAt;
  const endedAt =
    typeof task.endedAt === "number"
      ? Math.max(task.endedAt, startedAt ?? createdAt)
      : task.endedAt;

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

function cloneTaskDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  return {
    ...state,
    ...(state.requesterOrigin ? { requesterOrigin: { ...state.requesterOrigin } } : {}),
  };
}

function snapshotTaskRecords(source: ReadonlyMap<string, TaskRecord>): TaskRecord[] {
  return [...source.values()].map((record) => cloneTaskRecord(record));
}

function emitTaskRegistryObserverEvent(createEvent: () => TaskRegistryObserverEvent): void {
  const observers = getTaskRegistryObservers();
  if (!observers?.onEvent) {
    return;
  }
  try {
    observers.onEvent(createEvent());
  } catch (error) {
    log.warn("Task registry observer failed", {
      event: "task-registry",
      error,
    });
  }
}

function persistTaskRegistry(): boolean {
  try {
    getTaskRegistryStore().saveSnapshot({
      tasks,
      deliveryStates: taskDeliveryStates,
    });
    return true;
  } catch (error) {
    log.warn("Failed to persist task registry snapshot", { error });
    return false;
  }
}

function persistTaskUpsert(task: TaskRecord, pendingDeliveryState?: TaskDeliveryState): void {
  const store = getTaskRegistryStore();
  const deliveryState = pendingDeliveryState ?? taskDeliveryStates.get(task.taskId);
  if (store.upsertTaskWithDeliveryState) {
    store.upsertTaskWithDeliveryState({
      task,
      ...(deliveryState ? { deliveryState } : {}),
    });
    return;
  }
  if (!deliveryState && store.upsertTask) {
    store.upsertTask(task);
    return;
  }
  // Snapshot fallback: project the pending upsert so the snapshot is correct
  // even though we persist before mutating memory. Delivery state must stay in
  // the same write as its task; split upserts can leave a durable half-create.
  store.saveSnapshot({
    tasks: new Map(tasks).set(task.taskId, task),
    deliveryStates: deliveryState
      ? new Map(taskDeliveryStates).set(task.taskId, deliveryState)
      : taskDeliveryStates,
  });
}

function tryPersistTaskUpsert(
  task: TaskRecord,
  operation: string,
  pendingDeliveryState?: TaskDeliveryState,
): boolean {
  try {
    persistTaskUpsert(task, pendingDeliveryState);
    return true;
  } catch (error) {
    log.warn("Failed to persist task registry upsert", {
      operation,
      taskId: task.taskId,
      runId: task.runId,
      error,
    });
    return false;
  }
}

function persistTaskDelete(taskId: string) {
  const store = getTaskRegistryStore();
  if (store.deleteTaskWithDeliveryState) {
    // Composite delete removes the task row and its delivery state in a single
    // transaction. This is the only atomic "remove both records" store
    // primitive, and the one the default sqlite store uses.
    store.deleteTaskWithDeliveryState(taskId);
    return;
  }
  // No atomic composite delete is available: persist the removal of BOTH the
  // task and its delivery state in one projected snapshot. saveSnapshot is a
  // required store method and writes atomically. Using the separate deleteTask
  // / deleteDeliveryState methods instead would either leave the delivery-state
  // row behind (a task-only delete) or, if both were called, reintroduce a
  // two-write divergence window when the second delete threw before the
  // in-memory mutation. Projecting both deletions into a single snapshot keeps
  // the persisted store consistent under the persist-before-in-memory ordering.
  const projectedTasks = new Map(tasks);
  projectedTasks.delete(taskId);
  const projectedDeliveryStates = new Map(taskDeliveryStates);
  projectedDeliveryStates.delete(taskId);
  store.saveSnapshot({
    tasks: projectedTasks,
    deliveryStates: projectedDeliveryStates,
  });
}

function tryPersistTaskDelete(taskId: string): boolean {
  try {
    persistTaskDelete(taskId);
    return true;
  } catch (error) {
    log.warn("Failed to persist task registry delete", {
      taskId,
      error,
    });
    return false;
  }
}

function persistTaskDeliveryStateUpsert(state: TaskDeliveryState) {
  const store = getTaskRegistryStore();
  if (store.upsertDeliveryState) {
    store.upsertDeliveryState(state);
    return;
  }
  const projectedDeliveryStates = new Map(taskDeliveryStates);
  projectedDeliveryStates.set(state.taskId, cloneTaskDeliveryState(state));
  store.saveSnapshot({
    tasks,
    deliveryStates: projectedDeliveryStates,
  });
}

function tryPersistTaskDeliveryStateUpsert(state: TaskDeliveryState): boolean {
  try {
    persistTaskDeliveryStateUpsert(state);
    return true;
  } catch (error) {
    log.warn("Failed to persist task delivery state", {
      taskId: state.taskId,
      error,
    });
    return false;
  }
}

function clearTaskRegistryMemory(): void {
  clearTaskFlowSyncRetries();
  tasks.clear();
  taskDeliveryStates.clear();
  taskIdsByRunId.clear();
  taskIdsByOwnerKey.clear();
  taskIdsByParentFlowId.clear();
  taskIdsByRelatedSessionKey.clear();
  tasksWithPendingDelivery.clear();
}

function ensureDeliveryStatus(params: {
  ownerKey: string;
  scopeKind: TaskScopeKind;
}): TaskDeliveryStatus {
  if (params.scopeKind === "system") {
    return "not_applicable";
  }
  return params.ownerKey.trim() ? "pending" : "parent_missing";
}

function ensureNotifyPolicy(params: {
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

function resolveTaskScopeKind(params: {
  scopeKind?: TaskScopeKind;
  requesterSessionKey: string;
}): TaskScopeKind {
  if (params.scopeKind) {
    return params.scopeKind;
  }
  return params.requesterSessionKey.trim() ? "session" : "system";
}

function resolveTaskRequesterSessionKey(params: {
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

function resolveTaskOwnerKey(params: { requesterSessionKey: string; ownerKey?: string }): string {
  return params.ownerKey?.trim() || params.requesterSessionKey.trim();
}

function normalizeTaskSummary(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizeTaskStatus(value: TaskStatus | null | undefined): TaskStatus {
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

function shouldApplyRunScopedStatusUpdate(params: {
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

function resolveTaskTerminalOutcome(params: {
  status: TaskStatus;
  terminalOutcome?: TaskTerminalOutcome | null;
}): TaskTerminalOutcome | undefined {
  const normalized = normalizeTaskTerminalOutcome(params.terminalOutcome);
  if (normalized) {
    return normalized;
  }
  return params.status === "succeeded" ? "succeeded" : undefined;
}

function mapAgentRunTerminalOutcomeToTaskStatus(
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

function resolveTaskLifecycleTerminalError(params: {
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

function buildTaskLifecycleTerminalOutcome(params: {
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

function appendTaskEvent(event: {
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

function loadTaskRegistryDeliveryRuntime() {
  const deliveryRuntimeOverride = (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY
  ];
  if (deliveryRuntimeOverride) {
    return Promise.resolve(deliveryRuntimeOverride);
  }
  return deliveryRuntimeLoader.load();
}

function loadTaskRegistryControlRuntime() {
  const controlRuntimeOverride = (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY
  ];
  if (controlRuntimeOverride) {
    return Promise.resolve(controlRuntimeOverride);
  }
  // Registry reads happen far more often than task cancellation, so keep the ACP/subagent
  // control graph off the default import path until a cancellation flow actually needs it.
  return controlRuntimeLoader.load();
}

function addRunIdIndex(taskId: string, runId?: string) {
  const trimmed = runId?.trim();
  if (!trimmed) {
    return;
  }
  let ids = taskIdsByRunId.get(trimmed);
  if (!ids) {
    ids = new Set<string>();
    taskIdsByRunId.set(trimmed, ids);
  }
  ids.add(taskId);
}

function addIndexedKey(index: Map<string, Set<string>>, key: string, taskId: string) {
  let ids = index.get(key);
  if (!ids) {
    ids = new Set<string>();
    index.set(key, ids);
  }
  ids.add(taskId);
}

function deleteIndexedKey(index: Map<string, Set<string>>, key: string, taskId: string) {
  const ids = index.get(key);
  if (!ids) {
    return;
  }
  ids.delete(taskId);
  if (ids.size === 0) {
    index.delete(key);
  }
}

function getTaskRelatedSessionIndexKeys(task: Pick<TaskRecord, "ownerKey" | "childSessionKey">) {
  return uniqueStrings(
    [normalizeOptionalString(task.ownerKey), normalizeOptionalString(task.childSessionKey)].filter(
      Boolean,
    ) as string[],
  );
}

function addOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeOptionalString(task.ownerKey);
  if (!key) {
    return;
  }
  addIndexedKey(taskIdsByOwnerKey, key, taskId);
}

function deleteOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeOptionalString(task.ownerKey);
  if (!key) {
    return;
  }
  deleteIndexedKey(taskIdsByOwnerKey, key, taskId);
}

function addParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  addIndexedKey(taskIdsByParentFlowId, key, taskId);
}

function deleteParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  deleteIndexedKey(taskIdsByParentFlowId, key, taskId);
}

function addRelatedSessionKeyIndex(
  taskId: string,
  task: Pick<TaskRecord, "ownerKey" | "childSessionKey">,
) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    addIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

function deleteRelatedSessionKeyIndex(
  taskId: string,
  task: Pick<TaskRecord, "ownerKey" | "childSessionKey">,
) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    deleteIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

function rebuildRunIdIndex() {
  taskIdsByRunId.clear();
  for (const [taskId, task] of tasks.entries()) {
    addRunIdIndex(taskId, task.runId);
  }
}

function rebuildOwnerKeyIndex() {
  taskIdsByOwnerKey.clear();
  for (const [taskId, task] of tasks.entries()) {
    addOwnerKeyIndex(taskId, task);
  }
}

function rebuildParentFlowIdIndex() {
  taskIdsByParentFlowId.clear();
  for (const [taskId, task] of tasks.entries()) {
    addParentFlowIdIndex(taskId, task);
  }
}

function rebuildRelatedSessionKeyIndex() {
  taskIdsByRelatedSessionKey.clear();
  for (const [taskId, task] of tasks.entries()) {
    addRelatedSessionKeyIndex(taskId, task);
  }
}

function getTasksByRunId(runId: string): TaskRecord[] {
  const ids = taskIdsByRunId.get(runId.trim());
  if (!ids || ids.size === 0) {
    return [];
  }
  return [...ids]
    .map((taskId) => tasks.get(taskId))
    .filter((task): task is TaskRecord => Boolean(task));
}

function taskRunScopeKey(
  task: Pick<TaskRecord, "runtime" | "scopeKind" | "ownerKey" | "childSessionKey">,
): string {
  return [
    task.runtime,
    task.scopeKind,
    normalizeOptionalString(task.ownerKey) ?? "",
    normalizeOptionalString(task.childSessionKey) ?? "",
  ].join("\u0000");
}

function getTasksByRunScope(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
}): TaskRecord[] {
  const matches = getTasksByRunId(params.runId).filter(
    (task) => !params.runtime || task.runtime === params.runtime,
  );
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (sessionKey) {
    const childMatches = matches.filter(
      (task) => normalizeOptionalString(task.childSessionKey) === sessionKey,
    );
    if (childMatches.length > 0) {
      return childMatches;
    }
    const ownerMatches = matches.filter(
      (task) =>
        task.scopeKind === "session" && normalizeOptionalString(task.ownerKey) === sessionKey,
    );
    return ownerMatches;
  }
  const scopeKeys = new Set(matches.map((task) => taskRunScopeKey(task)));
  return scopeKeys.size <= 1 ? matches : [];
}

function getPeerTasksForDelivery(task: TaskRecord): TaskRecord[] {
  if (!task.runId?.trim()) {
    return [];
  }
  return getTasksByRunId(task.runId).filter(
    (candidate) =>
      candidate.runtime === task.runtime &&
      candidate.scopeKind === task.scopeKind &&
      (normalizeOptionalString(candidate.ownerKey) ?? "") ===
        (normalizeOptionalString(task.ownerKey) ?? "") &&
      (normalizeOptionalString(candidate.childSessionKey) ?? "") ===
        (normalizeOptionalString(task.childSessionKey) ?? ""),
  );
}

function taskLookupPriority(task: TaskRecord): number {
  const runtimePriority = task.runtime === "cli" ? 1 : 0;
  return runtimePriority;
}

function pickPreferredRunIdTask(matches: TaskRecord[]): TaskRecord | undefined {
  return [...matches].toSorted((left, right) => {
    const priorityDiff = taskLookupPriority(left) - taskLookupPriority(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return left.createdAt - right.createdAt;
  })[0];
}

function compareTasksNewestFirst(
  left: Pick<TaskRecord, "createdAt"> & { insertionIndex?: number },
  right: Pick<TaskRecord, "createdAt"> & { insertionIndex?: number },
): number {
  const createdAtDiff = right.createdAt - left.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return (right.insertionIndex ?? 0) - (left.insertionIndex ?? 0);
}

function findExistingTaskForCreate(params: {
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

function mergeExistingTaskForCreate(
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
  },
): TaskRecord | null {
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
  if (Object.keys(patch).length === 0) {
    return cloneTaskRecord(existing);
  }
  return updateTask(existing.taskId, patch);
}

function resolveTaskAgentId(params: {
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

function resolveTaskRequesterAgentId(params: {
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

function taskTerminalDeliveryIdempotencyKey(task: TaskRecord): string {
  const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
  return `task-terminal:${task.taskId}:${task.status}:${outcome}`;
}

function resolveTaskStateChangeIdempotencyKey(params: {
  task: TaskRecord;
  latestEvent: TaskEventRecord;
  owner: TaskDeliveryOwner;
}): string {
  if (params.owner.flowId) {
    return `flow-event:${params.owner.flowId}:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
  }
  return `task-event:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
}

function resolveTaskTerminalIdempotencyKey(task: TaskRecord): string {
  const owner = resolveTaskDeliveryOwner(task);
  if (owner.flowId) {
    const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
    return `flow-terminal:${owner.flowId}:${task.taskId}:${task.status}:${outcome}`;
  }
  return taskTerminalDeliveryIdempotencyKey(task);
}

function getLinkedFlowForDelivery(task: TaskRecord) {
  const flowId = task.parentFlowId?.trim();
  if (!flowId || task.scopeKind !== "session") {
    return undefined;
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    return undefined;
  }
  if (normalizeOptionalString(flow.ownerKey) !== normalizeOptionalString(task.ownerKey)) {
    return undefined;
  }
  return flow;
}

function resolveTaskDeliveryOwner(task: TaskRecord): TaskDeliveryOwner {
  const flow = getLinkedFlowForDelivery(task);
  if (flow) {
    return {
      sessionKey: flow.ownerKey.trim(),
      requesterOrigin: normalizeDeliveryContext(
        flow.requesterOrigin ?? taskDeliveryStates.get(task.taskId)?.requesterOrigin,
      ),
      flowId: flow.flowId,
    };
  }
  if (task.scopeKind !== "session") {
    return {};
  }
  return {
    sessionKey: task.ownerKey.trim(),
    requesterOrigin: normalizeDeliveryContext(taskDeliveryStates.get(task.taskId)?.requesterOrigin),
  };
}

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

function syncFlowFromTaskAfterTaskMutation(task: TaskRecord, operation: string): void {
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

function clearTaskFlowSyncRetries(): void {
  for (const timer of taskFlowSyncRetryTimers.values()) {
    clearTimeout(timer);
  }
  taskFlowSyncRetryTimers.clear();
}

function restoreTaskRegistryOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = getTaskRegistryStore().loadSnapshot();
    if (restored.tasks.size === 0 && restored.deliveryStates.size === 0) {
      return;
    }
    for (const [taskId, task] of restored.tasks.entries()) {
      tasks.set(taskId, normalizeTaskTimestamps(task));
    }
    for (const [taskId, state] of restored.deliveryStates.entries()) {
      taskDeliveryStates.set(taskId, state);
    }
    rebuildRunIdIndex();
    rebuildOwnerKeyIndex();
    rebuildParentFlowIdIndex();
    rebuildRelatedSessionKeyIndex();
    emitTaskRegistryObserverEvent(() => ({
      kind: "restored",
      tasks: snapshotTaskRecords(tasks),
    }));
  } catch (error) {
    const message = formatErrorMessage(error);
    // Compact console logs omit structured metadata, so keep the rejected value visible there too.
    log.warn("Failed to restore task registry", {
      error: message,
      consoleMessage: `Failed to restore task registry: ${message}`,
    });
  }
}

export function ensureTaskRegistryReady() {
  restoreTaskRegistryOnce();
  ensureListener();
}

export function reloadTaskRegistryFromStore(): void {
  clearTaskRegistryMemory();
  restoreAttempted = false;
  restoreTaskRegistryOnce();
}

function updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
  const current = tasks.get(taskId);
  if (!current) {
    return null;
  }
  const next = normalizeTaskTimestamps({ ...current, ...patch });
  if (Object.hasOwn(patch, "error") && patch.error === undefined) {
    delete next.error;
  }
  if (isTerminalTaskStatus(next.status) && typeof next.cleanupAfter !== "number") {
    next.cleanupAfter = resolveTaskCleanupAfter({
      ...next,
      createdAt: next.createdAt ?? Date.now(),
    });
  }
  const sessionIndexChanged =
    normalizeOptionalString(current.ownerKey) !== normalizeOptionalString(next.ownerKey) ||
    normalizeOptionalString(current.childSessionKey) !==
      normalizeOptionalString(next.childSessionKey);
  const parentFlowIndexChanged = current.parentFlowId?.trim() !== next.parentFlowId?.trim();
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

function upsertTaskDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
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

function getTaskDeliveryState(taskId: string): TaskDeliveryState | undefined {
  const state = taskDeliveryStates.get(taskId);
  return state ? cloneTaskDeliveryState(state) : undefined;
}

function canDeliverTaskToRequesterOrigin(task: TaskRecord): boolean {
  const owner = resolveTaskDeliveryOwner(task);
  if (shouldRouteCompletionThroughRequesterSession(owner.sessionKey)) {
    return false;
  }
  return canDeliverToRequesterOrigin(owner.requesterOrigin);
}

function canDeliverToRequesterOrigin(origin: TaskDeliveryState["requesterOrigin"]): boolean {
  const channel = origin?.channel?.trim();
  const to = origin?.to?.trim();
  return Boolean(channel && to && isDeliverableMessageChannel(channel));
}

function canDeliverParentReviewTaskToBoundDiscordThread(task: TaskRecord): boolean {
  if (!shouldUseParentReviewTaskTerminalMessage(task)) {
    return false;
  }
  const owner = resolveTaskDeliveryOwner(task);
  const origin = owner.requesterOrigin;
  const channel = origin?.channel?.trim().toLowerCase();
  const to = origin?.to?.trim().toLowerCase();
  const threadId = String(origin?.threadId ?? "").trim();
  // This is a narrow transport exception for explicitly bound Discord threads,
  // not a general parent-review direct-delivery relaxation.
  return Boolean(
    channel === "discord" &&
    to?.startsWith("channel:") &&
    threadId &&
    canDeliverToRequesterOrigin(origin),
  );
}

function resolveMissingOwnerDeliveryStatus(task: TaskRecord): TaskDeliveryStatus {
  return task.scopeKind === "system" ? "not_applicable" : "parent_missing";
}

function queueTaskSystemEvent(task: TaskRecord, text: string) {
  const owner = resolveTaskDeliveryOwner(task);
  const ownerKey = owner.sessionKey?.trim();
  if (!ownerKey) {
    return false;
  }
  enqueueSystemEvent(text, {
    sessionKey: ownerKey,
    contextKey: `task:${task.taskId}`,
    deliveryContext: owner.requesterOrigin,
  });
  requestHeartbeat({
    source: "background-task",
    intent: "immediate",
    reason: "background-task",
    sessionKey: ownerKey,
  });
  return true;
}

function queueBlockedTaskFollowup(task: TaskRecord) {
  const followupText = formatTaskBlockedFollowupMessage(task);
  if (!followupText) {
    return false;
  }
  const owner = resolveTaskDeliveryOwner(task);
  const ownerKey = owner.sessionKey?.trim();
  if (!ownerKey) {
    return false;
  }
  enqueueSystemEvent(followupText, {
    sessionKey: ownerKey,
    contextKey: `task:${task.taskId}:blocked-followup`,
    deliveryContext: owner.requesterOrigin,
  });
  requestHeartbeat({
    source: "background-task-blocked",
    intent: "immediate",
    reason: "background-task-blocked",
    sessionKey: ownerKey,
  });
  return true;
}

export async function maybeDeliverTaskTerminalUpdate(taskId: string): Promise<TaskRecord | null> {
  return await runTaskDeliveryWithIndependentAdmission(taskId, async () =>
    maybeDeliverTaskTerminalUpdateUnderAdmission(taskId),
  );
}

async function runTaskDeliveryWithIndependentAdmission(
  taskId: string,
  deliver: () => Promise<TaskRecord | null>,
): Promise<TaskRecord | null> {
  let admitted = false;
  try {
    return await runWithGatewayIndependentRootWorkAdmission(async () => {
      admitted = true;
      return await deliver();
    });
  } catch (error) {
    // Late lifecycle callbacks must not leak a rejected detached promise after
    // restart closes admission. An already-admitted delivery still reports its
    // own failures instead of hiding them behind a concurrent restart.
    if (!admitted && isGatewayRestartDraining()) {
      const current = tasks.get(taskId);
      return current ? cloneTaskRecord(current) : null;
    }
    throw error;
  }
}

async function maybeDeliverTaskTerminalUpdateUnderAdmission(
  taskId: string,
): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskTerminalUpdate(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  if (tasksWithPendingDelivery.has(taskId)) {
    return cloneTaskRecord(current);
  }
  tasksWithPendingDelivery.add(taskId);
  try {
    const latest = tasks.get(taskId);
    if (!latest || !shouldAutoDeliverTaskTerminalUpdate(latest)) {
      return latest ? cloneTaskRecord(latest) : null;
    }
    const peers = latest.runId ? getPeerTasksForDelivery(latest) : [];
    const isSubagentCancellation = latest.runtime === "subagent" && latest.status === "cancelled";
    const preferred = pickPreferredRunIdTask(
      isSubagentCancellation
        ? peers.filter((candidate) => shouldAutoDeliverTaskTerminalUpdate(candidate))
        : peers,
    );
    const peerDeliveryCovered =
      isSubagentCancellation &&
      peers.some(
        (candidate) =>
          candidate.taskId !== latest.taskId &&
          (candidate.deliveryStatus === "delivered" ||
            candidate.deliveryStatus === "session_queued"),
      );
    if (
      shouldSuppressDuplicateTerminalDelivery({
        task: latest,
        preferredTaskId: preferred?.taskId,
        peerDeliveryCovered,
      })
    ) {
      return updateTask(taskId, {
        deliveryStatus: "not_applicable",
        lastEventAt: Date.now(),
      });
    }
    const owner = resolveTaskDeliveryOwner(latest);
    const ownerSessionKey = owner.sessionKey?.trim();
    if (!ownerSessionKey) {
      return updateTask(taskId, {
        deliveryStatus: resolveMissingOwnerDeliveryStatus(latest),
        lastEventAt: Date.now(),
      });
    }
    const shouldRouteParentReview = shouldUseParentReviewTaskTerminalMessage(latest);
    const shouldDeliverParentReviewDirect = canDeliverParentReviewTaskToBoundDiscordThread(latest);
    const canDeliverDirect =
      canDeliverTaskToRequesterOrigin(latest) || shouldDeliverParentReviewDirect;
    const directEventText = formatTaskTerminalMessage(latest);
    const sessionEventText = formatTaskTerminalMessage(
      latest,
      shouldRouteParentReview ? { surface: "parent_session" } : undefined,
    );
    if ((shouldRouteParentReview && !shouldDeliverParentReviewDirect) || !canDeliverDirect) {
      try {
        queueTaskSystemEvent(latest, sessionEventText);
        if (latest.terminalOutcome === "blocked") {
          queueBlockedTaskFollowup(latest);
        }
        return updateTask(taskId, {
          deliveryStatus:
            shouldRouteParentReview && canDeliverDirect ? "pending" : "session_queued",
          lastEventAt: Date.now(),
        });
      } catch (error) {
        log.warn("Failed to queue background task session delivery", {
          taskId,
          ownerKey: latest.ownerKey,
          error,
        });
        return updateTask(taskId, {
          deliveryStatus: "failed",
          lastEventAt: Date.now(),
        });
      }
    }
    try {
      const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
      const beforeSend = tasks.get(taskId);
      if (!beforeSend || !shouldAutoDeliverTaskTerminalUpdate(beforeSend)) {
        return beforeSend ? cloneTaskRecord(beforeSend) : null;
      }
      const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
      const idempotencyKey = resolveTaskTerminalIdempotencyKey(latest);
      await sendMessage({
        channel: owner.requesterOrigin?.channel,
        to: owner.requesterOrigin?.to ?? "",
        accountId: owner.requesterOrigin?.accountId,
        threadId: owner.requesterOrigin?.threadId,
        content: shouldDeliverParentReviewDirect ? sessionEventText : directEventText,
        agentId: requesterAgentId,
        idempotencyKey,
        mirror: {
          sessionKey: ownerSessionKey,
          agentId: requesterAgentId,
          idempotencyKey,
        },
      });
      const afterSend = tasks.get(taskId);
      if (!afterSend || !shouldAutoDeliverTaskTerminalUpdate(afterSend)) {
        return afterSend ? cloneTaskRecord(afterSend) : null;
      }
      if (afterSend.terminalOutcome === "blocked") {
        queueBlockedTaskFollowup(afterSend);
      }
      return updateTask(taskId, {
        deliveryStatus: "delivered",
        lastEventAt: Date.now(),
      });
    } catch (error) {
      log.warn("Failed to deliver background task update", {
        taskId,
        ownerKey: ownerSessionKey,
        requesterOrigin: owner.requesterOrigin,
        error,
      });
      const beforeFallback = tasks.get(taskId);
      if (!beforeFallback || !shouldAutoDeliverTaskTerminalUpdate(beforeFallback)) {
        return beforeFallback ? cloneTaskRecord(beforeFallback) : null;
      }
      try {
        queueTaskSystemEvent(beforeFallback, sessionEventText);
        if (beforeFallback.terminalOutcome === "blocked") {
          queueBlockedTaskFollowup(beforeFallback);
        }
      } catch (fallbackError) {
        log.warn("Failed to queue background task fallback event", {
          taskId,
          ownerKey: latest.ownerKey,
          error: fallbackError,
        });
      }
      return updateTask(taskId, {
        deliveryStatus: "failed",
        lastEventAt: Date.now(),
      });
    }
  } finally {
    tasksWithPendingDelivery.delete(taskId);
  }
}

export async function maybeDeliverTaskStateChangeUpdate(
  taskId: string,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  return await runTaskDeliveryWithIndependentAdmission(taskId, async () =>
    maybeDeliverTaskStateChangeUpdateUnderAdmission(taskId, latestEvent),
  );
}

async function maybeDeliverTaskStateChangeUpdateUnderAdmission(
  taskId: string,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current || !shouldAutoDeliverTaskStateChange(current)) {
    return current ? cloneTaskRecord(current) : null;
  }
  const deliveryState = getTaskDeliveryState(taskId);
  if (!latestEvent || (deliveryState?.lastNotifiedEventAt ?? 0) >= latestEvent.at) {
    return cloneTaskRecord(current);
  }
  const eventText = formatTaskStateChangeMessage(current, latestEvent);
  if (!eventText) {
    return cloneTaskRecord(current);
  }
  try {
    const owner = resolveTaskDeliveryOwner(current);
    const ownerSessionKey = owner.sessionKey?.trim();
    if (!ownerSessionKey) {
      return updateTask(taskId, {
        deliveryStatus: resolveMissingOwnerDeliveryStatus(current),
        lastEventAt: Date.now(),
      });
    }
    if (!canDeliverTaskToRequesterOrigin(current)) {
      queueTaskSystemEvent(current, eventText);
      upsertTaskDeliveryState({
        taskId,
        requesterOrigin: deliveryState?.requesterOrigin,
        lastNotifiedEventAt: latestEvent.at,
      });
      return updateTask(taskId, {
        lastEventAt: Date.now(),
      });
    }
    const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
    const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
    const idempotencyKey = resolveTaskStateChangeIdempotencyKey({
      task: current,
      latestEvent,
      owner,
    });
    await sendMessage({
      channel: owner.requesterOrigin?.channel,
      to: owner.requesterOrigin?.to ?? "",
      accountId: owner.requesterOrigin?.accountId,
      threadId: owner.requesterOrigin?.threadId,
      content: eventText,
      agentId: requesterAgentId,
      idempotencyKey,
      mirror: {
        sessionKey: ownerSessionKey,
        agentId: requesterAgentId,
        idempotencyKey,
      },
    });
    upsertTaskDeliveryState({
      taskId,
      requesterOrigin: deliveryState?.requesterOrigin,
      lastNotifiedEventAt: latestEvent.at,
    });
    return updateTask(taskId, {
      lastEventAt: Date.now(),
    });
  } catch (error) {
    log.warn("Failed to deliver background task state change", {
      taskId,
      ownerKey: current.ownerKey,
      error,
    });
    return cloneTaskRecord(current);
  }
}

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
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
}): TaskRecord | null {
  ensureTaskRegistryReady();
  const patch: Partial<TaskRecord> = {
    status: params.status,
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt ?? params.endedAt,
    ...(params.terminalSummary !== undefined
      ? { terminalSummary: normalizeTaskSummary(params.terminalSummary) }
      : {}),
    ...(params.terminalOutcome !== undefined
      ? {
          terminalOutcome: resolveTaskTerminalOutcome({
            status: params.status,
            terminalOutcome: params.terminalOutcome,
          }),
        }
      : {}),
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

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = onAgentEvent((evt) => {
    restoreTaskRegistryOnce();
    const scopedTasks = getTasksByRunScope({
      runId: evt.runId,
      sessionKey: evt.sessionKey,
    });
    if (scopedTasks.length === 0) {
      return;
    }
    const now = evt.ts || Date.now();
    for (const current of scopedTasks) {
      if (isTerminalTaskStatus(current.status)) {
        continue;
      }
      const patch: Partial<TaskRecord> = {
        lastEventAt: now,
      };
      if (evt.stream === "lifecycle") {
        const phase = typeof evt.data?.phase === "string" ? evt.data.phase : undefined;
        const startedAt =
          typeof evt.data?.startedAt === "number" ? evt.data.startedAt : current.startedAt;
        const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : undefined;
        if (startedAt) {
          patch.startedAt = startedAt;
        }
        if (phase === "start") {
          patch.status = "running";
        } else if (phase === "end") {
          const terminal = buildTaskLifecycleTerminalOutcome({
            phase,
            data: evt.data,
            startedAt,
            endedAt: endedAt ?? now,
          });
          patch.status = mapAgentRunTerminalOutcomeToTaskStatus(terminal);
          patch.endedAt = terminal.endedAt ?? now;
          const error = resolveTaskLifecycleTerminalError({
            runtime: current.runtime,
            status: patch.status,
            error: terminal.error,
          });
          if (error) {
            patch.error = error;
          }
        } else if (phase === "error") {
          const terminal = buildTaskLifecycleTerminalOutcome({
            phase,
            data: evt.data,
            startedAt,
            endedAt: endedAt ?? now,
          });
          patch.status = mapAgentRunTerminalOutcomeToTaskStatus(terminal);
          patch.endedAt = terminal.endedAt ?? now;
          patch.error =
            resolveTaskLifecycleTerminalError({
              runtime: current.runtime,
              status: patch.status,
              error: terminal.error,
            }) ?? current.error;
        }
      } else if (evt.stream === "error") {
        patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
      } else if (evt.stream === "tool" && evt.data?.phase === "start") {
        // Tool starts are the activity signal surfaced in task summaries; ends
        // and outputs only refresh lastEventAt.
        const toolName = typeof evt.data.name === "string" ? evt.data.name.trim() : "";
        if (toolName) {
          patch.toolUseCount = (current.toolUseCount ?? 0) + 1;
          patch.lastToolName = toolName;
        }
      }
      const stateChangeEvent =
        patch.status && patch.status !== current.status
          ? appendTaskEvent({
              at: now,
              kind: patch.status,
              summary:
                patch.status === "failed"
                  ? (patch.error ?? current.error)
                  : patch.status === "succeeded"
                    ? current.terminalSummary
                    : undefined,
            })
          : undefined;
      const updated = updateTask(current.taskId, patch);
      if (updated) {
        void maybeDeliverTaskStateChangeUpdate(current.taskId, stateChangeEvent);
        void maybeDeliverTaskTerminalUpdate(current.taskId);
      }
    }
  });
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
  });
  if (isTerminalTaskStatus(record.status) && typeof record.cleanupAfter !== "number") {
    record.cleanupAfter = resolveTaskCleanupAfter(record);
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

function updateTaskStateByRunId(params: {
  runId: string;
  runtime?: TaskRuntime;
  sessionKey?: string;
  status?: TaskStatus;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
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
    if (
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
      patch.terminalSummary = normalizeTaskSummary(params.terminalSummary);
    }
    if (params.terminalOutcome !== undefined) {
      patch.terminalOutcome = resolveTaskTerminalOutcome({
        status: nextStatus,
        terminalOutcome: params.terminalOutcome,
      });
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
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  startedAt?: number;
  endedAt: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  terminalOutcome?: TaskTerminalOutcome | null;
  suppressDelivery?: boolean;
}) {
  return updateTaskStateByRunId({
    runId: params.runId,
    runtime: params.runtime,
    sessionKey: params.sessionKey,
    status: params.status,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt,
    error: params.error,
    progressSummary: params.progressSummary,
    terminalSummary: params.terminalSummary,
    terminalOutcome: params.terminalOutcome,
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

export async function cancelTaskById(params: {
  cfg: OpenClawConfig;
  taskId: string;
  reason?: string;
}): Promise<{ found: boolean; cancelled: boolean; reason?: string; task?: TaskRecord }> {
  ensureTaskRegistryReady();
  const task = tasks.get(params.taskId.trim());
  if (!task) {
    return { found: false, cancelled: false, reason: "Task not found." };
  }
  const requestedReason = params.reason?.trim();
  const cancellationError =
    requestedReason && requestedReason !== SUBAGENT_KILL_TASK_ERROR
      ? requestedReason
      : "Cancelled by operator.";
  let isProvisionalSubagentKill =
    task.runtime === "subagent" &&
    task.status === "cancelled" &&
    task.error === SUBAGENT_KILL_TASK_ERROR;
  if (
    !isProvisionalSubagentKill &&
    (task.status === "succeeded" ||
      task.status === "failed" ||
      task.status === "timed_out" ||
      task.status === "lost" ||
      task.status === "cancelled")
  ) {
    return {
      found: true,
      cancelled: false,
      reason: "Task is already terminal.",
      task: cloneTaskRecord(task),
    };
  }
  const childSessionKey = task.childSessionKey?.trim();
  try {
    // A direct kill is only a provisional terminal projection. Re-read the
    // owning subagent run before promotion so its canonical completion can win.
    if (task.runtime !== "cli") {
      if (task.runtime === "cron") {
        if (
          !cancelActiveCronTaskRun({
            runId: task.runId,
            reason: params.reason?.trim() || "Cancelled by operator.",
          })
        ) {
          if (childSessionKey) {
            return {
              found: true,
              cancelled: false,
              reason: "Cron task has no active cancellation handle.",
              task: cloneTaskRecord(task),
            };
          }
          // Childless cron rows are stale legacy ledger records; with no live
          // runner handle and no child session to cancel, clear the task row.
        }
      } else if (!childSessionKey) {
        if (!isChildlessNativeSubagentTask(task)) {
          return {
            found: true,
            cancelled: false,
            reason: "Task has no cancellable child session.",
            task: cloneTaskRecord(task),
          };
        }
      }
      if (task.runtime === "cron") {
        // The live cron service owns the abort signal; registry finalization below
        // keeps CLI/Gateway callers aligned while the run unwinds.
      } else if (!childSessionKey) {
        // Codex native subagents are mirrored from the Codex app server and do
        // not have OpenClaw child sessions to terminate. Cancellation clears
        // the stale task-registry record only.
      } else if (task.runtime === "acp") {
        const { getAcpSessionManager } = await loadTaskRegistryControlRuntime();
        await getAcpSessionManager().cancelSession({
          cfg: params.cfg,
          sessionKey: childSessionKey,
          reason: params.reason?.trim() || "task-cancel",
        });
      } else if (task.runtime === "subagent") {
        const { killSubagentRunAdmin } = await loadTaskRegistryControlRuntime();
        const result = await killSubagentRunAdmin({
          cfg: params.cfg,
          sessionKey: childSessionKey,
        });
        const current = tasks.get(task.taskId);
        if (current?.status === "cancelled" && current.error === SUBAGENT_KILL_TASK_ERROR) {
          isProvisionalSubagentKill = true;
        }
        if (current?.status === "succeeded") {
          return {
            found: true,
            cancelled: false,
            reason: "Subagent completed while cancellation was in progress.",
            task: cloneTaskRecord(current),
          };
        }
        if (current && isTerminalTaskStatus(current.status) && current.status !== "cancelled") {
          return {
            found: true,
            cancelled: false,
            reason: `Subagent became ${current.status} while cancellation was in progress.`,
            task: cloneTaskRecord(current),
          };
        }
        if (current?.status === "cancelled" && !isProvisionalSubagentKill) {
          return {
            found: true,
            cancelled: false,
            reason: "Subagent was cancelled while cancellation was in progress.",
            task: cloneTaskRecord(current),
          };
        }
        if (result.found && result.targetState?.state === "terminal") {
          // A subagent run becomes terminal before its task projection settles.
          // Reconcile the original task scope: steer/orphan recovery may have
          // replaced the registry run ID without remapping durable task rows.
          const taskRunId = task.runId?.trim() || result.runId;
          const reconciledTasks = finalizeTaskRunByRunId({
            runId: taskRunId,
            runtime: "subagent",
            sessionKey: childSessionKey,
            ...result.targetState.task,
          });
          const reconciled = reconciledTasks.find((candidate) => candidate.taskId === task.taskId);
          if (!reconciled) {
            return {
              found: true,
              cancelled: false,
              reason: "Subagent became terminal, but task state reconciliation failed to persist.",
              task: cloneTaskRecord(tasks.get(task.taskId) ?? task),
            };
          }
          if (
            result.targetState.task.status === "cancelled" &&
            result.targetState.task.error === SUBAGENT_KILL_TASK_ERROR
          ) {
            isProvisionalSubagentKill = true;
          } else {
            const reason =
              result.targetState.task.status === "succeeded"
                ? "Subagent completed while cancellation was in progress."
                : `Subagent became ${result.targetState.task.status} while cancellation was in progress.`;
            return {
              found: true,
              cancelled: false,
              reason,
              task: cloneTaskRecord(reconciled),
            };
          }
        }
        if (result.found && result.targetState?.state === "finalizing") {
          return {
            found: true,
            cancelled: false,
            reason: "Subagent completion is still being finalized.",
            task: cloneTaskRecord(current ?? task),
          };
        }
        if ((!result.found || !result.killed) && !isProvisionalSubagentKill) {
          return {
            found: true,
            cancelled: false,
            reason: result.found ? "Subagent was not running." : "Subagent task not found.",
            task: cloneTaskRecord(current ?? task),
          };
        }
      } else {
        return {
          found: true,
          cancelled: false,
          reason: "Task runtime does not support cancellation yet.",
          task: cloneTaskRecord(task),
        };
      }
    }
    const eventAt = Date.now();
    const current = tasks.get(task.taskId) ?? task;
    const endedAt = isProvisionalSubagentKill ? (current.endedAt ?? eventAt) : eventAt;
    const updated =
      (task.runtime === "acp" || task.runtime === "subagent") && task.runId?.trim()
        ? (updateTaskStateByRunId({
            runId: task.runId,
            runtime: task.runtime,
            sessionKey: childSessionKey,
            status: "cancelled",
            endedAt,
            lastEventAt: eventAt,
            error: cancellationError,
          }).find((record) => record.taskId === task.taskId) ?? null)
        : updateTask(task.taskId, {
            status: "cancelled",
            endedAt,
            lastEventAt: eventAt,
            error: cancellationError,
          });
    if (!updated) {
      return {
        found: true,
        cancelled: false,
        reason: "Task persistence failed.",
        task: cloneTaskRecord(task),
      };
    }
    if (updated) {
      void maybeDeliverTaskTerminalUpdate(updated.taskId);
    }
    return {
      found: true,
      cancelled: true,
      task: updated ?? cloneTaskRecord(task),
    };
  } catch (error) {
    return {
      found: true,
      cancelled: false,
      reason: formatErrorMessage(error),
      task: cloneTaskRecord(task),
    };
  }
}

// Callers that provide their own order use this cloned snapshot to avoid paying
// for listTaskRecords' createdAt sort before immediately discarding that order.
export function listTaskRecordsUnsorted(): TaskRecord[] {
  ensureTaskRegistryReady();
  return snapshotTaskRecords(tasks);
}

export function listTaskRecords(): TaskRecord[] {
  ensureTaskRegistryReady();
  return [...tasks.values()]
    .map((task, insertionIndex) => Object.assign({}, cloneTaskRecord(task), { insertionIndex }))
    .toSorted(compareTasksNewestFirst)
    .map(({ insertionIndex: _, ...task }) => task);
}

export function hasActiveTaskForChildSessionKey(params: {
  sessionKey: string;
  excludeTaskId?: string;
}): boolean {
  ensureTaskRegistryReady();
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const ids = taskIdsByRelatedSessionKey.get(sessionKey);
  if (!ids) {
    return false;
  }
  for (const taskId of ids) {
    if (taskId === params.excludeTaskId) {
      continue;
    }
    const task = tasks.get(taskId);
    if (
      task &&
      isActiveTaskStatus(task.status) &&
      normalizeOptionalString(task.childSessionKey) === sessionKey
    ) {
      return true;
    }
  }
  return false;
}

export function getTaskById(taskId: string): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const task = tasks.get(taskId.trim());
  return task ? cloneTaskRecord(task) : undefined;
}

export function findTaskByRunId(runId: string): TaskRecord | undefined {
  ensureTaskRegistryReady();
  const task = pickPreferredRunIdTask(getTasksByRunId(runId));
  return task ? cloneTaskRecord(task) : undefined;
}

function listTasksFromIndex(index: Map<string, Set<string>>, key: string): TaskRecord[] {
  const ids = index.get(key);
  if (!ids || ids.size === 0) {
    return [];
  }
  return [...ids]
    .map((taskId, insertionIndex) => {
      const task = tasks.get(taskId);
      return task ? Object.assign({}, cloneTaskRecord(task), { insertionIndex }) : null;
    })
    .filter(
      (
        task,
      ): task is TaskRecord & {
        insertionIndex: number;
      } => Boolean(task),
    )
    .toSorted(compareTasksNewestFirst)
    .map(({ insertionIndex: _, ...task }) => task);
}

export function listTasksForSessionKey(sessionKey: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByRelatedSessionKey, key);
}

export function listTasksForAgentId(agentId: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const lookup = agentId.trim();
  if (!lookup) {
    return [];
  }
  return snapshotTaskRecords(tasks)
    .filter((task) => task.agentId?.trim() === lookup)
    .toSorted(compareTasksNewestFirst);
}

export function findLatestTaskForFlowId(flowId: string): TaskRecord | undefined {
  const task = listTasksForFlowId(flowId)[0];
  return task ? cloneTaskRecord(task) : undefined;
}

export function listTasksForOwnerKey(ownerKey: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeOptionalString(ownerKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByOwnerKey, key);
}

export function listFreshTasksForOwnerKey(ownerKey: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeOptionalString(ownerKey);
  if (!key) {
    return [];
  }
  const store = getTaskRegistryStore();
  if (store.listTasksForOwnerKey) {
    try {
      const merged = new Map<string, TaskRecord>();
      for (const task of store.listTasksForOwnerKey(key)) {
        merged.set(task.taskId, cloneTaskRecord(normalizeTaskTimestamps(task)));
      }
      return [...merged.values()]
        .map((task, insertionIndex) => Object.assign({}, task, { insertionIndex }))
        .toSorted(compareTasksNewestFirst)
        .map(({ insertionIndex: _, ...task }) => task);
    } catch (error) {
      log.warn("Failed to read fresh owner task registry records", {
        ownerKey: key,
        error,
      });
    }
  }

  return listTasksFromIndex(taskIdsByOwnerKey, key);
}

export function listTasksForFlowId(flowId: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = flowId.trim();
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByParentFlowId, key);
}

export function findLatestTaskForRelatedSessionKey(sessionKey: string): TaskRecord | undefined {
  const task = listTasksForRelatedSessionKey(sessionKey)[0];
  return task ? cloneTaskRecord(task) : undefined;
}

export function listTasksForRelatedSessionKey(sessionKey: string): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByRelatedSessionKey, key);
}

export function resolveTaskForLookupToken(token: string): TaskRecord | undefined {
  const lookup = token.trim();
  if (!lookup) {
    return undefined;
  }
  return (
    getTaskById(lookup) ?? findTaskByRunId(lookup) ?? findLatestTaskForRelatedSessionKey(lookup)
  );
}

export function deleteTaskRecordById(taskId: string): boolean {
  ensureTaskRegistryReady();
  const current = tasks.get(taskId);
  if (!current) {
    return false;
  }
  // Persist the delete before mutating memory, as a single atomic store
  // operation. If persistence fails, leave the in-memory record intact and
  // report that no delete was applied.
  if (!tryPersistTaskDelete(taskId)) {
    return false;
  }
  deleteOwnerKeyIndex(taskId, current);
  deleteParentFlowIdIndex(taskId, current);
  deleteRelatedSessionKeyIndex(taskId, current);
  tasks.delete(taskId);
  taskDeliveryStates.delete(taskId);
  rebuildRunIdIndex();
  emitTaskRegistryObserverEvent(() => ({
    kind: "deleted",
    taskId: current.taskId,
    previous: cloneTaskRecord(current),
  }));
  return true;
}

export function resetTaskRegistryForTests(opts?: { persist?: boolean }) {
  clearTaskRegistryMemory();
  restoreAttempted = false;
  resetTaskRegistryRuntimeForTests();
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  deliveryRuntimeLoader.clear();
  controlRuntimeLoader.clear();
  if (opts?.persist !== false) {
    persistTaskRegistry();
  }
  // Always close the sqlite handle so Windows temp-dir cleanup can remove the
  // state directory even when a test intentionally skips persisting the reset.
  getTaskRegistryStore().close?.();
}

export function resetTaskRegistryDeliveryRuntimeForTests() {
  (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY
  ] = null;
  deliveryRuntimeLoader.clear();
}

export function setTaskRegistryDeliveryRuntimeForTests(runtime: TaskRegistryDeliveryRuntime): void {
  (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY
  ] = runtime;
  deliveryRuntimeLoader.clear();
}

export function resetTaskRegistryControlRuntimeForTests() {
  (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY
  ] = null;
  controlRuntimeLoader.clear();
}

export function setTaskRegistryControlRuntimeForTests(runtime: TaskRegistryControlRuntime): void {
  (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY
  ] = runtime;
  controlRuntimeLoader.clear();
}
