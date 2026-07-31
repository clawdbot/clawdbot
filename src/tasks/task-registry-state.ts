import { createRequire } from "node:module";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";
import {
  cloneTaskDeliveryState,
  cloneTaskRecord,
  normalizeTaskTimestamps,
} from "./task-registry-records.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
import {
  getTaskRegistryObservers,
  getTaskRegistryStore,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
import type { TaskDeliveryState, TaskRecord, TaskRuntime } from "./task-registry.types.js";

export const log = createSubsystemLogger("tasks/registry");
export const TASK_FLOW_SYNC_RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 120_000, 600_000] as const;

const taskRegistryProcessState = getTaskRegistryProcessState();
export const tasks = taskRegistryProcessState.tasks;
export const taskDeliveryStates = taskRegistryProcessState.taskDeliveryStates;
const taskIdsByRunId = taskRegistryProcessState.taskIdsByRunId;
export const taskIdsByOwnerKey = taskRegistryProcessState.taskIdsByOwnerKey;
export const taskIdsByParentFlowId = taskRegistryProcessState.taskIdsByParentFlowId;
export const taskIdsByRelatedSessionKey = taskRegistryProcessState.taskIdsByRelatedSessionKey;
export const tasksWithPendingDelivery = taskRegistryProcessState.tasksWithPendingDelivery;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
type TaskRegistryRestoreState =
  | { status: "uninitialized" }
  | { status: "restoring" }
  | { status: "ready" }
  | { status: "failed"; error: Error };
let taskRegistryRestoreState: TaskRegistryRestoreState = { status: "uninitialized" };
export const taskFlowSyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
export type TaskRegistryDeliveryRuntime = Pick<
  typeof import("./task-registry-delivery-runtime.js"),
  "sendMessage"
>;
export const TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY = Symbol.for(
  "openclaw.taskRegistry.deliveryRuntimeOverride",
);
export const TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY = Symbol.for(
  "openclaw.taskRegistry.controlRuntimeOverride",
);
const require = createRequire(import.meta.url);
const TASK_REGISTRY_CONTROL_RUNTIME_CANDIDATES = [
  "./task-registry-control.runtime.js",
  "./task-registry-control.runtime.ts",
] as const;
export type TaskRegistryGlobalWithRuntimeOverrides = typeof globalThis & {
  [TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY]?: TaskRegistryDeliveryRuntime | null;
  [TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY]?: TaskRegistryControlRuntime | null;
};
export const deliveryRuntimeLoader = createLazyPromiseLoader(
  () => import("./task-registry-delivery-runtime.js"),
  { cacheRejections: true },
);
export const controlRuntimeLoader = createLazyPromiseLoader(
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

let listenerStarter: () => void = () => {};

export function setTaskRegistryListenerStarter(starter: () => void): void {
  listenerStarter = starter;
}

export function claimTaskRegistryListenerStart(): boolean {
  if (listenerStarted) {
    return false;
  }
  listenerStarted = true;
  return true;
}

export function setTaskRegistryListenerStop(stop: (() => void) | null): void {
  listenerStop = stop;
}

export function resetTaskRegistryListenerState(): void {
  listenerStop?.();
  listenerStop = null;
  listenerStarted = false;
}

function clearTaskFlowSyncRetries(): void {
  for (const timer of taskFlowSyncRetryTimers.values()) {
    clearTimeout(timer);
  }
  taskFlowSyncRetryTimers.clear();
}

export function snapshotTaskRecords(source: ReadonlyMap<string, TaskRecord>): TaskRecord[] {
  return [...source.values()].map((record) => cloneTaskRecord(record));
}

export function emitTaskRegistryObserverEvent(createEvent: () => TaskRegistryObserverEvent): void {
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

export function persistTaskRegistry(): boolean {
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

export function tryPersistTaskUpsert(
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

export function tryPersistTaskDelete(taskId: string): boolean {
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

export function tryPersistTaskDeliveryStateUpsert(state: TaskDeliveryState): boolean {
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

export function clearTaskRegistryMemory(): void {
  clearTaskFlowSyncRetries();
  tasks.clear();
  taskDeliveryStates.clear();
  taskIdsByRunId.clear();
  taskIdsByOwnerKey.clear();
  taskIdsByParentFlowId.clear();
  taskIdsByRelatedSessionKey.clear();
  tasksWithPendingDelivery.clear();
}

export function loadTaskRegistryDeliveryRuntime() {
  const deliveryRuntimeOverride = (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY
  ];
  if (deliveryRuntimeOverride) {
    return Promise.resolve(deliveryRuntimeOverride);
  }
  return deliveryRuntimeLoader.load();
}

export function loadTaskRegistryControlRuntime() {
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

export function addRunIdIndex(taskId: string, runId?: string) {
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

export function addOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeOptionalString(task.ownerKey);
  if (!key) {
    return;
  }
  addIndexedKey(taskIdsByOwnerKey, key, taskId);
}

export function deleteOwnerKeyIndex(taskId: string, task: Pick<TaskRecord, "ownerKey">) {
  const key = normalizeOptionalString(task.ownerKey);
  if (!key) {
    return;
  }
  deleteIndexedKey(taskIdsByOwnerKey, key, taskId);
}

export function addParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  addIndexedKey(taskIdsByParentFlowId, key, taskId);
}

export function deleteParentFlowIdIndex(taskId: string, task: Pick<TaskRecord, "parentFlowId">) {
  const key = task.parentFlowId?.trim();
  if (!key) {
    return;
  }
  deleteIndexedKey(taskIdsByParentFlowId, key, taskId);
}

export function addRelatedSessionKeyIndex(
  taskId: string,
  task: Pick<TaskRecord, "ownerKey" | "childSessionKey">,
) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    addIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

export function deleteRelatedSessionKeyIndex(
  taskId: string,
  task: Pick<TaskRecord, "ownerKey" | "childSessionKey">,
) {
  for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
    deleteIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
  }
}

export function rebuildRunIdIndex() {
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

export function getTasksByRunId(runId: string): TaskRecord[] {
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

export function getTasksByRunScope(params: {
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

export function getPeerTasksForDelivery(task: TaskRecord): TaskRecord[] {
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

export function pickPreferredRunIdTask(matches: TaskRecord[]): TaskRecord | undefined {
  return [...matches].toSorted((left, right) => {
    const priorityDiff = taskLookupPriority(left) - taskLookupPriority(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return left.createdAt - right.createdAt;
  })[0];
}

export function compareTasksNewestFirst(
  left: Pick<TaskRecord, "createdAt"> & { insertionIndex?: number },
  right: Pick<TaskRecord, "createdAt"> & { insertionIndex?: number },
): number {
  const createdAtDiff = right.createdAt - left.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return (right.insertionIndex ?? 0) - (left.insertionIndex ?? 0);
}

export function restoreTaskRegistryOnce() {
  switch (taskRegistryRestoreState.status) {
    case "ready":
      return;
    case "failed":
      throw taskRegistryRestoreState.error;
    case "restoring":
      throw new Error("Task registry restore is already in progress.");
    case "uninitialized":
      break;
  }
  taskRegistryRestoreState = { status: "restoring" };
  try {
    const restored = getTaskRegistryStore().loadSnapshot();
    const restoredTasks = new Map<string, TaskRecord>();
    for (const [taskId, task] of restored.tasks.entries()) {
      restoredTasks.set(taskId, normalizeTaskTimestamps(task));
    }
    const restoredDeliveryStates = new Map(restored.deliveryStates);

    clearTaskRegistryMemory();
    for (const [taskId, task] of restoredTasks.entries()) {
      tasks.set(taskId, task);
    }
    for (const [taskId, state] of restoredDeliveryStates.entries()) {
      taskDeliveryStates.set(taskId, state);
    }
    rebuildRunIdIndex();
    rebuildOwnerKeyIndex();
    rebuildParentFlowIdIndex();
    rebuildRelatedSessionKeyIndex();
    taskRegistryRestoreState = { status: "ready" };
    if (restoredTasks.size > 0 || restoredDeliveryStates.size > 0) {
      emitTaskRegistryObserverEvent(() => ({
        kind: "restored",
        tasks: snapshotTaskRecords(tasks),
      }));
    }
  } catch (error) {
    clearTaskRegistryMemory();
    const message = formatErrorMessage(error);
    const restoreError = new Error(`Task registry restore failed: ${message}`, { cause: error });
    taskRegistryRestoreState = { status: "failed", error: restoreError };
    // Compact console logs omit structured metadata, so keep the rejected value visible there too.
    log.warn("Failed to restore task registry", {
      error: message,
      consoleMessage: `Failed to restore task registry: ${message}`,
    });
    throw restoreError;
  }
}

export function ensureTaskRegistryReady(): void {
  restoreTaskRegistryOnce();
  listenerStarter();
}

export function reloadTaskRegistryFromStore(): void {
  clearTaskRegistryMemory();
  taskRegistryRestoreState = { status: "uninitialized" };
  ensureTaskRegistryReady();
}

export function resetTaskRegistryRestoreState(): void {
  taskRegistryRestoreState = { status: "uninitialized" };
}
