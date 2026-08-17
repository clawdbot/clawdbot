// Defines task registry records, statuses, delivery state, and parser helpers.
import type { DeliveryContext } from "../utils/delivery-context.types.js";

/** JSON value shape persisted with runtime-owned task detail. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Runtime families that own task run lifecycles. */
export const TASK_RUNTIMES = ["subagent", "acp", "cron", "cli"] as const;
export const TASK_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
] as const;

export type TaskRuntime = (typeof TASK_RUNTIMES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskDeliveryStatus =
  | "pending"
  | "delivered"
  | "session_queued"
  | "failed"
  | "dismissed"
  | "parent_missing"
  | "not_applicable";

export type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";

/** Semantic success detail for required-completion task outcomes. */
export type TaskTerminalOutcome = "succeeded" | "blocked";
export type TaskScopeKind = "session" | "system";

export type TaskStatusCounts = Record<TaskStatus, number>;
export type TaskRuntimeCounts = Record<TaskRuntime, number>;

const TASK_RUNTIME_SET = new Set<TaskRuntime>(TASK_RUNTIMES);
const TASK_STATUS_SET = new Set<TaskStatus>(TASK_STATUSES);
const TASK_DELIVERY_STATUSES = new Set<TaskDeliveryStatus>([
  "pending",
  "delivered",
  "session_queued",
  "failed",
  "dismissed",
  "parent_missing",
  "not_applicable",
]);
const TASK_NOTIFY_POLICIES = new Set<TaskNotifyPolicy>(["done_only", "state_changes", "silent"]);
const TASK_TERMINAL_OUTCOMES = new Set<TaskTerminalOutcome>(["succeeded", "blocked"]);
const TASK_SCOPE_KINDS = new Set<TaskScopeKind>(["session", "system"]);

function parsePersistedTaskValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value === "string" && values.has(value as T)) {
    return value as T;
  }
  throw new Error(`Invalid persisted task ${label}: ${JSON.stringify(value)}`);
}

export function parseTaskRuntime(value: unknown): TaskRuntime {
  return parsePersistedTaskValue(value, TASK_RUNTIME_SET, "runtime");
}

export function parseTaskStatus(value: unknown): TaskStatus {
  return parsePersistedTaskValue(value, TASK_STATUS_SET, "status");
}

export function parseTaskDeliveryStatus(value: unknown): TaskDeliveryStatus {
  return parsePersistedTaskValue(value, TASK_DELIVERY_STATUSES, "delivery status");
}

export function parseTaskNotifyPolicy(value: unknown): TaskNotifyPolicy {
  return parsePersistedTaskValue(value, TASK_NOTIFY_POLICIES, "notify policy");
}

export function parseTaskScopeKind(value: unknown): TaskScopeKind {
  return parsePersistedTaskValue(value, TASK_SCOPE_KINDS, "scope kind");
}

export function parseOptionalTaskTerminalOutcome(value: unknown): TaskTerminalOutcome | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  return parsePersistedTaskValue(value, TASK_TERMINAL_OUTCOMES, "terminal outcome");
}

export type TaskRegistrySummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: TaskStatusCounts;
  byRuntime: TaskRuntimeCounts;
};

export type TaskEventKind = TaskStatus | "progress";

export type TaskEventRecord = {
  at: number;
  kind: TaskEventKind;
  summary?: string;
};

export type TaskDeliveryState = {
  taskId: string;
  requesterOrigin?: DeliveryContext;
  lastNotifiedEventAt?: number;
};

export type TaskRecord = {
  taskId: string;
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey: string;
  ownerKey: string;
  scopeKind: TaskScopeKind;
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  /** Agent store for requester transcripts whose session key is unscoped, such as `global`.
   * Task authorization remains keyed by ownerKey. */
  requesterAgentId?: string;
  runId?: string;
  label?: string;
  task: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  /** Tool invocations observed on this run's agent-event stream. */
  toolUseCount?: number;
  /** Name of the most recent tool invocation observed for this run. */
  lastToolName?: string;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
  detail?: JsonValue;
};
