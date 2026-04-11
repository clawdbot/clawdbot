import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type TaskFlowRegistryStoreSnapshot = {
  flows: Map<string, TaskFlowRecord>;
};
