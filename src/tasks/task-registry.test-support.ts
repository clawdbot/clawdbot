import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";
import type { TaskEventRecord, TaskRecord } from "./task-registry.types.js";
import "./task-registry.js";

type TaskRegistryDeliveryRuntime = Pick<
  typeof import("./task-registry-delivery-runtime.js"),
  "sendMessage"
>;

type TaskRegistryTestApi = {
  maybeDeliverTaskStateChangeUpdate(
    taskId: string,
    latestEvent?: TaskEventRecord,
  ): Promise<TaskRecord | null>;
  resetTaskRegistryForTests(opts?: { persist?: boolean }): void;
  resetTaskRegistryDeliveryRuntimeForTests(): void;
  setTaskRegistryDeliveryRuntimeForTests(runtime: TaskRegistryDeliveryRuntime): void;
  resetTaskRegistryControlRuntimeForTests(): void;
  setTaskRegistryControlRuntimeForTests(runtime: TaskRegistryControlRuntime): void;
};

function getTestApi(): TaskRegistryTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.taskRegistryTestApi")
  ];
  if (!api) {
    throw new Error("task registry test API is unavailable");
  }
  return api as TaskRegistryTestApi;
}

export async function maybeDeliverTaskStateChangeUpdate(
  taskId: string,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  return await getTestApi().maybeDeliverTaskStateChangeUpdate(taskId, latestEvent);
}

export function resetTaskRegistryForTests(opts?: { persist?: boolean }): void {
  getTestApi().resetTaskRegistryForTests(opts);
}

export function resetTaskRegistryDeliveryRuntimeForTests(): void {
  getTestApi().resetTaskRegistryDeliveryRuntimeForTests();
}

export function setTaskRegistryDeliveryRuntimeForTests(runtime: TaskRegistryDeliveryRuntime): void {
  getTestApi().setTaskRegistryDeliveryRuntimeForTests(runtime);
}

export function resetTaskRegistryControlRuntimeForTests(): void {
  getTestApi().resetTaskRegistryControlRuntimeForTests();
}

export function setTaskRegistryControlRuntimeForTests(runtime: TaskRegistryControlRuntime): void {
  getTestApi().setTaskRegistryControlRuntimeForTests(runtime);
}
