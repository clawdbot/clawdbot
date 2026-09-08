// Test runtime helpers for task registry state and deterministic cleanup.
import {
  configureTaskRegistryRuntime,
  type TaskRegistryStore,
  type TaskRegistryStoreSnapshot,
} from "../tasks/task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "../tasks/task-registry.types.js";

// Clone snapshots across load/save so tests catch accidental shared mutation.
function cloneTask(task: TaskRecord): TaskRecord {
  return { ...task };
}

function cloneDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  return {
    ...state,
    ...(state.requesterOrigin ? { requesterOrigin: { ...state.requesterOrigin } } : {}),
  };
}

/** Installs an in-memory task registry store for tests that avoid disk state. */
export function installInMemoryTaskRegistryRuntime(): {
  taskStore: TaskRegistryStore;
} {
  let taskSnapshot: TaskRegistryStoreSnapshot = {
    tasks: new Map<string, TaskRecord>(),
    deliveryStates: new Map<string, TaskDeliveryState>(),
  };

  const taskStore: TaskRegistryStore = {
    loadSnapshot: () => ({
      tasks: new Map(
        [...taskSnapshot.tasks.entries()].map(([taskId, task]) => [taskId, cloneTask(task)]),
      ),
      deliveryStates: new Map(
        [...taskSnapshot.deliveryStates.entries()].map(([taskId, state]) => [
          taskId,
          cloneDeliveryState(state),
        ]),
      ),
    }),
    saveSnapshot: (snapshot) => {
      taskSnapshot = {
        tasks: new Map(
          [...snapshot.tasks.entries()].map(([taskId, task]) => [taskId, cloneTask(task)]),
        ),
        deliveryStates: new Map(
          [...snapshot.deliveryStates.entries()].map(([taskId, state]) => [
            taskId,
            cloneDeliveryState(state),
          ]),
        ),
      };
    },
    upsertTask: (task) => {
      taskSnapshot.tasks.set(task.taskId, cloneTask(task));
    },
    deleteTask: (taskId) => {
      taskSnapshot.tasks.delete(taskId);
    },
    upsertDeliveryState: (state) => {
      taskSnapshot.deliveryStates.set(state.taskId, cloneDeliveryState(state));
    },
    deleteDeliveryState: (taskId) => {
      taskSnapshot.deliveryStates.delete(taskId);
    },
  };

  configureTaskRegistryRuntime({ store: taskStore });
  return { taskStore };
}
