import type {
  getTaskFlowRegistryStore,
  TaskFlowRegistryObserverEvent,
} from "./task-flow-registry.store.js";
import "./task-flow-registry.store.js";

type TaskFlowRegistryStore = ReturnType<typeof getTaskFlowRegistryStore>;

type TaskFlowRegistryStoreTestApi = {
  configureTaskFlowRegistryRuntime(params: {
    store?: TaskFlowRegistryStore;
    observers?: { onEvent?: (event: TaskFlowRegistryObserverEvent) => void } | null;
  }): void;
};

function getTestApi(): TaskFlowRegistryStoreTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.taskFlowRegistryStoreTestApi")
  ];
  if (!api) {
    throw new Error("task flow registry store test API is unavailable");
  }
  return api as TaskFlowRegistryStoreTestApi;
}

export function configureTaskFlowRegistryRuntime(
  params: Parameters<TaskFlowRegistryStoreTestApi["configureTaskFlowRegistryRuntime"]>[0],
): void {
  getTestApi().configureTaskFlowRegistryRuntime(params);
}
