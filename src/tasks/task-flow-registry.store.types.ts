// Defines storage contracts for managed task-flow records.
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

/** Full task-flow registry snapshot used for persistence restore and replacement writes. */
export type TaskFlowRegistryStoreSnapshot = {
  flows: Map<string, TaskFlowRecord>;
};
