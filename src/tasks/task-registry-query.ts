import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isActiveTaskStatus, ensureLinkedTaskFlowRegistryReady } from "./task-registry-common.js";
import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";
import { cloneTaskRecord, normalizeTaskTimestamps } from "./task-registry-records.js";
import {
  TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY,
  TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY,
  clearTaskRegistryMemory,
  compareTasksNewestFirst,
  controlRuntimeLoader,
  deleteOwnerKeyIndex,
  deleteParentFlowIdIndex,
  deleteRelatedSessionKeyIndex,
  deliveryRuntimeLoader,
  emitTaskRegistryObserverEvent,
  ensureTaskRegistryReady,
  getTasksByRunId,
  log,
  persistTaskRegistry,
  pickPreferredRunIdTask,
  rebuildRunIdIndex,
  resetTaskRegistryListenerState,
  resetTaskRegistryRestoreState,
  snapshotTaskRecords,
  taskDeliveryStates,
  taskIdsByOwnerKey,
  taskIdsByParentFlowId,
  taskIdsByRelatedSessionKey,
  tasks,
  tryPersistTaskDelete,
  type TaskRegistryDeliveryRuntime,
  type TaskRegistryGlobalWithRuntimeOverrides,
} from "./task-registry-state.js";
import { getTaskRegistryStore, resetTaskRegistryRuntimeForTests } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

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

function findLatestTaskForRelatedSessionKey(sessionKey: string): TaskRecord | undefined {
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
  ensureLinkedTaskFlowRegistryReady(current);
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
  resetTaskRegistryRestoreState();
  resetTaskRegistryRuntimeForTests();
  resetTaskRegistryListenerState();
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
