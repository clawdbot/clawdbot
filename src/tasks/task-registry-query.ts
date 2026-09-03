import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearTaskActivity } from "./task-registry-activity.js";
import { isActiveTaskStatus, ensureLinkedTaskFlowRegistryReady } from "./task-registry-common.js";
import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";
import { cloneTaskRecord, normalizeTaskTimestamps } from "./task-registry-records.js";
import {
  TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY,
  TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY,
  bumpTaskRegistryRevision,
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
  taskRegistryLog,
  persistTaskRegistry,
  pickPreferredRunIdTask,
  readTaskRegistryRevision,
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
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";
import { resolveTaskSessionAgentId } from "./task-session-identity.js";

export function listTaskRecordsUnsorted(): TaskRecord[] {
  ensureTaskRegistryReady();
  return snapshotTaskRecords(tasks);
}

function taskMatchesRelatedSession(
  task: TaskRecord,
  sessionKey: string | undefined,
  sessionAgentId?: string,
  cfg?: OpenClawConfig,
): boolean {
  if (!sessionKey) {
    return true;
  }
  return [
    { key: task.requesterSessionKey, agentId: task.requesterAgentId },
    { key: task.childSessionKey, agentId: task.agentId },
    // ownerKey belongs to the requester. task.agentId is the executor/child
    // candidate and must never adopt a colliding bare requester session.
    { key: task.ownerKey, agentId: task.requesterAgentId },
  ].some((candidate) => {
    if (normalizeOptionalString(candidate.key) !== sessionKey) {
      return false;
    }
    if (!sessionAgentId) {
      return true;
    }
    return resolveTaskSessionAgentId(candidate.key, candidate.agentId, cfg) === sessionAgentId;
  });
}

function taskMatchesAgent(
  task: TaskRecord,
  agentId: string | undefined,
  cfg?: OpenClawConfig,
): boolean {
  if (!agentId) {
    return true;
  }
  const knownAgentId =
    normalizeOptionalString(task.agentId) ?? normalizeOptionalString(task.requesterAgentId);
  if (knownAgentId) {
    return knownAgentId === agentId;
  }
  return [task.requesterSessionKey, task.childSessionKey, task.ownerKey].some(
    (candidate) => resolveTaskSessionAgentId(candidate, undefined, cfg) === agentId,
  );
}

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function compareTaskPageOrder(left: TaskRecord, right: TaskRecord): number {
  const updatedDiff = taskUpdatedAt(right) - taskUpdatedAt(left);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
}

function siftWorstTaskDown(heap: TaskRecord[], startIndex: number): void {
  let index = startIndex;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= heap.length) {
      return;
    }
    const left = heap[leftIndex];
    const current = heap[index];
    if (!left || !current) {
      return;
    }
    const rightIndex = leftIndex + 1;
    let worstIndex = leftIndex;
    const right = heap[rightIndex];
    if (right && compareTaskPageOrder(right, left) > 0) {
      worstIndex = rightIndex;
    }
    const worst = heap[worstIndex];
    if (!worst || compareTaskPageOrder(worst, current) <= 0) {
      return;
    }
    heap[index] = worst;
    heap[worstIndex] = current;
    index = worstIndex;
  }
}

function heapifyWorstTaskFirst(heap: TaskRecord[]): void {
  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index -= 1) {
    siftWorstTaskDown(heap, index);
  }
}

const TASK_PAGE_MAX_ATTEMPTS = 3;

export async function listTaskRecordPage(params: {
  offset: number;
  limit: number;
  statuses?: readonly TaskStatus[];
  agentId?: string;
  sessionKey?: string;
  sessionAgentId?: string;
  cfg?: OpenClawConfig;
  filter?: (task: Readonly<TaskRecord>) => boolean;
}): Promise<Result<{ tasks: TaskRecord[]; hasMore: boolean }, "registry_changed">> {
  ensureTaskRegistryReady();
  const statuses = params.statuses ? new Set(params.statuses) : null;
  const agentId = normalizeOptionalString(params.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  // Filtering and ordering stay registry-owned so authoritative records never
  // cross the boundary; only the bounded selected page is defensively cloned.
  const windowSize = params.offset + params.limit;
  for (let attempt = 0; attempt < TASK_PAGE_MAX_ATTEMPTS; attempt += 1) {
    const revision = readTaskRegistryRevision();
    const scanLimit = tasks.size;
    const window: TaskRecord[] = [];
    let matchingCount = 0;
    let heapReady = false;
    let scannedCount = 0;
    for (const task of tasks.values()) {
      if (scannedCount >= scanLimit) {
        break;
      }
      scannedCount += 1;
      // Yield large scans in small deterministic slices so task history cannot
      // monopolize the Gateway event loop while other requests are waiting.
      if (scannedCount % 32 === 0) {
        await yieldToEventLoop();
      }
      if (
        (statuses && !statuses.has(task.status)) ||
        !taskMatchesAgent(task, agentId, params.cfg) ||
        !taskMatchesRelatedSession(task, sessionKey, params.sessionAgentId, params.cfg) ||
        (params.filter && !params.filter(task))
      ) {
        continue;
      }
      matchingCount += 1;
      if (windowSize <= 0) {
        continue;
      }
      if (window.length < windowSize) {
        window.push(task);
        continue;
      }
      if (!heapReady) {
        heapifyWorstTaskFirst(window);
        heapReady = true;
      }
      const cutoff = window[0];
      if (cutoff && compareTaskPageOrder(task, cutoff) < 0) {
        window[0] = task;
        siftWorstTaskDown(window, 0);
      }
    }
    if (revision !== readTaskRegistryRevision()) {
      continue;
    }
    if (params.offset >= matchingCount) {
      return ok({ tasks: [], hasMore: false });
    }
    const selected = window.toSorted(compareTaskPageOrder).slice(params.offset);
    return ok({
      tasks: selected.map((task) => cloneTaskRecord(task)),
      hasMore: params.offset + selected.length < matchingCount,
    });
  }
  return err("registry_changed");
}

export function listTaskRecords(filter?: (task: Readonly<TaskRecord>) => boolean): TaskRecord[] {
  ensureTaskRegistryReady();
  const records = [...tasks.values()];
  return (filter ? records.filter(filter) : records)
    .map((task, insertionIndex) => Object.assign({}, cloneTaskRecord(task), { insertionIndex }))
    .toSorted(compareTasksNewestFirst)
    .map(({ insertionIndex: _insertionIndex, ...task }) => task);
}

export function hasActiveTaskForChildSessionKey(params: {
  sessionKey: string;
  agentId?: string;
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
      normalizeOptionalString(task.childSessionKey) === sessionKey &&
      (!params.agentId ||
        resolveTaskSessionAgentId(task.childSessionKey, task.agentId) === params.agentId)
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
    .map(({ insertionIndex: _insertionIndex, ...task }) => task);
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
        .map(({ insertionIndex: _insertionIndex, ...task }) => task);
    } catch (error) {
      taskRegistryLog.warn("Failed to read fresh owner task registry records", {
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

export function listTasksForRelatedSessionKey(
  sessionKey: string,
  sessionAgentId?: string,
): TaskRecord[] {
  ensureTaskRegistryReady();
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return [];
  }
  return listTasksFromIndex(taskIdsByRelatedSessionKey, key).filter((task) =>
    taskMatchesRelatedSession(task, key, sessionAgentId),
  );
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
  clearTaskActivity(taskId);
  tasks.delete(taskId);
  bumpTaskRegistryRevision();
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
