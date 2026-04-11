import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type TaskRegistryStoreSnapshot = {
  tasks: Map<string, TaskRecord>;
  deliveryStates: Map<string, TaskDeliveryState>;
};
