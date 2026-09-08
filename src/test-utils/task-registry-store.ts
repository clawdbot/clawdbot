import type { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import type { TaskFlowRegistryStoreSnapshot } from "../tasks/task-flow-registry.store.types.js";
import type { TaskRegistryStore, TaskRegistryStoreSnapshot } from "../tasks/task-registry.store.js";

type TaskFlowRegistryStore = ReturnType<typeof getTaskFlowRegistryStore>;

export function createInMemoryTaskRegistryStore(
  snapshot: TaskRegistryStoreSnapshot = { tasks: new Map(), deliveryStates: new Map() },
): TaskRegistryStore {
  const state = structuredClone(snapshot);
  return {
    loadSnapshot: () => structuredClone(state),
    upsertTaskWithDeliveryState: ({ task, deliveryState }) => {
      const nextTask = structuredClone(task);
      const nextDeliveryState = deliveryState ? structuredClone(deliveryState) : undefined;
      state.tasks.set(task.taskId, nextTask);
      if (nextDeliveryState) {
        state.deliveryStates.set(task.taskId, nextDeliveryState);
      } else {
        state.deliveryStates.delete(task.taskId);
      }
    },
    deleteTaskWithDeliveryState: (taskId) => {
      state.tasks.delete(taskId);
      state.deliveryStates.delete(taskId);
    },
    upsertDeliveryState: (deliveryState) => {
      state.deliveryStates.set(deliveryState.taskId, structuredClone(deliveryState));
    },
  };
}

export function createInMemoryTaskFlowRegistryStore(
  snapshot: TaskFlowRegistryStoreSnapshot = { flows: new Map() },
): TaskFlowRegistryStore {
  const state = structuredClone(snapshot);
  return {
    loadSnapshot: () => structuredClone(state),
    upsertFlow: (flow) => {
      state.flows.set(flow.flowId, structuredClone(flow));
    },
    deleteFlow: (flowId) => {
      state.flows.delete(flowId);
    },
  };
}
