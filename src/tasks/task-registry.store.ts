import {
  closeTaskRegistrySqliteStore,
  deleteTaskAndDeliveryStateFromSqlite,
  deleteTaskDeliveryStateFromSqlite,
  deleteTaskRegistryRecordFromSqlite,
  loadTaskRegistryStateFromSqlite,
  saveTaskRegistryStateToSqlite,
  upsertTaskWithDeliveryStateToSqlite,
  upsertTaskDeliveryStateToSqlite,
  upsertTaskRegistryRecordToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";

export type TaskRegistryStore = {
  loadSnapshot: () => TaskRegistryStoreSnapshot;
  saveSnapshot: (snapshot: TaskRegistryStoreSnapshot) => void;
  upsertTaskWithDeliveryState?: (params: {
    task: TaskRecord;
    deliveryState?: TaskDeliveryState;
  }) => void;
  upsertTask?: (task: TaskRecord) => void;
  deleteTaskWithDeliveryState?: (taskId: string) => void;
  deleteTask?: (taskId: string) => void;
  upsertDeliveryState?: (state: TaskDeliveryState) => void;
  deleteDeliveryState?: (taskId: string) => void;
  close?: () => void;
};

export type TaskRegistryObserverEvent =
  | {
      kind: "restored";
      tasks: TaskRecord[];
    }
  | {
      kind: "upserted";
      task: TaskRecord;
      previous?: TaskRecord;
    }
  | {
      kind: "deleted";
      taskId: string;
      previous: TaskRecord;
    };

export type TaskRegistryObservers = {
  // Observers are incremental/best-effort only. Snapshot persistence belongs to TaskRegistryStore.
  onEvent?: (event: TaskRegistryObserverEvent) => void;
};

const defaultTaskRegistryStore: TaskRegistryStore = {
  loadSnapshot: loadTaskRegistryStateFromSqlite,
  saveSnapshot: saveTaskRegistryStateToSqlite,
  upsertTaskWithDeliveryState: upsertTaskWithDeliveryStateToSqlite,
  upsertTask: upsertTaskRegistryRecordToSqlite,
  deleteTaskWithDeliveryState: deleteTaskAndDeliveryStateFromSqlite,
  deleteTask: deleteTaskRegistryRecordFromSqlite,
  upsertDeliveryState: upsertTaskDeliveryStateToSqlite,
  deleteDeliveryState: deleteTaskDeliveryStateFromSqlite,
  close: closeTaskRegistrySqliteStore,
};

let configuredTaskRegistryStore: TaskRegistryStore = defaultTaskRegistryStore;
let configuredTaskRegistryObservers: TaskRegistryObservers | null = null;

export function getTaskRegistryStore(): TaskRegistryStore {
  return configuredTaskRegistryStore;
}

export function getTaskRegistryObservers(): TaskRegistryObservers | null {
  return configuredTaskRegistryObservers;
}

export function configureTaskRegistryRuntime(params: {
  store?: TaskRegistryStore;
  observers?: TaskRegistryObservers | null;
}) {
  if (params.store) {
    configuredTaskRegistryStore = params.store;
  }
  if ("observers" in params) {
    configuredTaskRegistryObservers = params.observers ?? null;
  }
}

export function resetTaskRegistryRuntimeForTests() {
  configuredTaskRegistryStore.close?.();
  configuredTaskRegistryStore = defaultTaskRegistryStore;
  configuredTaskRegistryObservers = null;
}
