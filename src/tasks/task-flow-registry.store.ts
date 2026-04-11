import {
  closeTaskFlowRegistrySqliteStore,
  deleteTaskFlowRegistryRecordFromSqlite,
  loadTaskFlowRegistryStateFromSqlite,
  saveTaskFlowRegistryStateToSqlite,
  upsertTaskFlowRegistryRecordToSqlite,
} from "./task-flow-registry.store.sqlite.js";
import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";

export type TaskFlowRegistryStore = {
  loadSnapshot: () => TaskFlowRegistryStoreSnapshot;
  saveSnapshot: (snapshot: TaskFlowRegistryStoreSnapshot) => void;
  upsertFlow?: (flow: TaskFlowRecord) => void;
  deleteFlow?: (flowId: string) => void;
  close?: () => void;
};

export type TaskFlowRegistryObserverEvent =
  | {
      kind: "restored";
      flows: TaskFlowRecord[];
    }
  | {
      kind: "upserted";
      flow: TaskFlowRecord;
      previous?: TaskFlowRecord;
    }
  | {
      kind: "deleted";
      flowId: string;
      previous: TaskFlowRecord;
    };

export type TaskFlowRegistryObservers = {
  // Observers are incremental/best-effort only. Snapshot persistence belongs to TaskFlowRegistryStore.
  onEvent?: (event: TaskFlowRegistryObserverEvent) => void;
};

const defaultFlowRegistryStore: TaskFlowRegistryStore = {
  loadSnapshot: loadTaskFlowRegistryStateFromSqlite,
  saveSnapshot: saveTaskFlowRegistryStateToSqlite,
  upsertFlow: upsertTaskFlowRegistryRecordToSqlite,
  deleteFlow: deleteTaskFlowRegistryRecordFromSqlite,
  close: closeTaskFlowRegistrySqliteStore,
};

let configuredFlowRegistryStore: TaskFlowRegistryStore = defaultFlowRegistryStore;
let configuredFlowRegistryObservers: TaskFlowRegistryObservers | null = null;

export function getTaskFlowRegistryStore(): TaskFlowRegistryStore {
  return configuredFlowRegistryStore;
}

export function getTaskFlowRegistryObservers(): TaskFlowRegistryObservers | null {
  return configuredFlowRegistryObservers;
}

export function configureTaskFlowRegistryRuntime(params: {
  store?: TaskFlowRegistryStore;
  observers?: TaskFlowRegistryObservers | null;
}) {
  if (params.store) {
    configuredFlowRegistryStore = params.store;
  }
  if ("observers" in params) {
    configuredFlowRegistryObservers = params.observers ?? null;
  }
}

export function resetTaskFlowRegistryRuntimeForTests() {
  configuredFlowRegistryStore.close?.();
  configuredFlowRegistryStore = defaultFlowRegistryStore;
  configuredFlowRegistryObservers = null;
}
