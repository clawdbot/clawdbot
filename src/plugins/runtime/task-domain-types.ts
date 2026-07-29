// Task domain types define plugin task-flow payloads shared by runtime adapters.
import type { JsonValue } from "../../tasks/task-flow-registry.types.js";
import type {
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRuntime,
  TaskScopeKind,
  TaskRuntimeCounts,
  TaskStatus,
  TaskStatusCounts,
  TaskTerminalOutcome,
} from "../../tasks/task-registry.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

/** Aggregate task-run counts exposed to plugin task views. */
export type TaskRunAggregateSummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: TaskStatusCounts;
  byRuntime: TaskRuntimeCounts;
};

/** Public task run summary exposed through plugin runtime task APIs. */
export type TaskRunView = {
  id: string;
  runtime: TaskRuntime;
  sourceId?: string;
  sessionKey: string;
  ownerKey: string;
  scope: TaskScopeKind;
  childSessionKey?: string;
  flowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  title: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
};

/** Detailed task run view; currently equal to the summary view. */
export type TaskRunDetail = TaskRunView;

/** Result returned when cancelling a task run. */
export type TaskRunCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  task?: TaskRunDetail;
};

/** Public task flow summary exposed through plugin runtime task APIs. */
export type TaskFlowView = {
  id: string;
  ownerKey: string;
  requesterOrigin?: DeliveryContext;
  status: import("../../tasks/task-flow-registry.types.js").TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

/** Detailed task flow view with state, wait, blocked, and task summary data. */
export type TaskFlowDetail = TaskFlowView & {
  state?: JsonValue;
  wait?: JsonValue;
  blocked?: {
    taskId?: string;
    summary?: string;
  };
  tasks: TaskRunView[];
  taskSummary: TaskRunAggregateSummary;
};
