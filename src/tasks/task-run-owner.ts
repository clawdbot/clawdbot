import { err } from "@openclaw/normalization-core/result";
import { getTaskRegistryProcessState, type TaskRunOwner } from "./task-registry.process-state.js";
import type { TaskRecord } from "./task-registry.types.js";

export function getTaskRunOwner(task: TaskRecord): TaskRunOwner | undefined {
  const owner = getTaskRegistryProcessState().runOwners.get(task.taskId);
  // Store reloads replace record objects, but cannot transfer the producer's fixed task scope.
  return owner &&
    owner.task.runtime === task.runtime &&
    owner.task.ownerKey === task.ownerKey &&
    owner.task.scopeKind === task.scopeKind &&
    owner.task.runId === task.runId &&
    owner.task.childSessionKey === task.childSessionKey
    ? owner
    : undefined;
}

export function bindTaskRunOwner(task: TaskRecord, cancel: TaskRunOwner["cancel"]): () => void {
  const state = getTaskRegistryProcessState();
  const owner: TaskRunOwner = {
    task,
    cancel: (reason) => {
      const current = state.tasks.get(task.taskId);
      // Retained callbacks cannot control deleted, rebound, or replaced tasks.
      if (!current || getTaskRunOwner(current) !== owner) {
        return Promise.resolve(err("Task no longer belongs to this live run."));
      }
      return cancel(reason);
    },
  };
  state.runOwners.set(task.taskId, owner);
  return () => {
    // An old producer must not remove its replacement's registration.
    if (state.runOwners.get(task.taskId) === owner) {
      state.runOwners.delete(task.taskId);
    }
  };
}
