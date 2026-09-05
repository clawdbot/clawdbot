// Tracks task process state transitions used to reconcile running work.
import type { Result } from "@openclaw/normalization-core/result";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type TaskRunOwner = {
  task: Readonly<
    Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
  >;
  cancel: (reason: string) => Promise<Result<TaskRecord, string>>;
};

export type TaskActivityOverlayState = {
  runId: string;
  assistantText: string;
  thinkingText: string;
  hasAssistantActivity: boolean;
  lastActivity?: string;
  files: Set<string>;
  added: number;
  removed: number;
  pendingDiffByToolCallId: Map<string, { files: string[]; added: number; removed: number }>;
  dirty: boolean;
  lastFlushedAt?: number;
  flushTimer?: ReturnType<typeof setTimeout>;
};

/** Process-local indexes backing task lookup, owner access, and pending delivery scans. */
type TaskRegistryProcessState = {
  tasks: Map<string, TaskRecord>;
  taskDeliveryStates: Map<string, TaskDeliveryState>;
  taskIdsByRunId: Map<string, Set<string>>;
  taskIdsByOwnerKey: Map<string, Set<string>>;
  taskIdsByParentFlowId: Map<string, Set<string>>;
  taskIdsByRelatedSessionKey: Map<string, Set<string>>;
  tasksWithPendingDelivery: Set<string>;
  /** Ephemeral live activity is intentionally discarded on gateway restart. */
  taskActivityByTaskId: Map<string, TaskActivityOverlayState>;
  /** Live owners survive store reloads, but are never persisted or restored after restart. */
  runOwners: Map<string, TaskRunOwner>;
  // Listener ownership must survive module reloads alongside the task indexes it updates.
  listenerStop?: (() => void) | null;
};

const TASK_REGISTRY_PROCESS_STATE_KEY = Symbol.for("openclaw.taskRegistry.state");

/** Returns the singleton in-process task registry state. */
export function getTaskRegistryProcessState(): TaskRegistryProcessState {
  const globalState = globalThis as typeof globalThis & {
    [TASK_REGISTRY_PROCESS_STATE_KEY]?: TaskRegistryProcessState;
  };
  globalState[TASK_REGISTRY_PROCESS_STATE_KEY] ??= {
    tasks: new Map<string, TaskRecord>(),
    taskDeliveryStates: new Map<string, TaskDeliveryState>(),
    taskIdsByRunId: new Map<string, Set<string>>(),
    taskIdsByOwnerKey: new Map<string, Set<string>>(),
    taskIdsByParentFlowId: new Map<string, Set<string>>(),
    taskIdsByRelatedSessionKey: new Map<string, Set<string>>(),
    tasksWithPendingDelivery: new Set<string>(),
    taskActivityByTaskId: new Map<string, TaskActivityOverlayState>(),
    runOwners: new Map<string, TaskRunOwner>(),
  };
  return globalState[TASK_REGISTRY_PROCESS_STATE_KEY];
}
