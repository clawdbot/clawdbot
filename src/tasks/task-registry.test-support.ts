import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";
import { createTaskRecord as createTaskRecordOrNull } from "./task-registry.js";
import type { TaskEventRecord, TaskRecord } from "./task-registry.types.js";

type CreateTaskRecordParams = Parameters<typeof createTaskRecordOrNull>[0];
type TaskFixtureDefaults = "runtime" | "ownerKey" | "scopeKind" | "status" | "deliveryStatus";
type TaskFixtureParams = Omit<CreateTaskRecordParams, TaskFixtureDefaults> &
  Partial<Pick<CreateTaskRecordParams, Exclude<TaskFixtureDefaults, "runtime">>>;

export function createTaskFixture(
  runtime: CreateTaskRecordParams["runtime"],
  params: TaskFixtureParams,
): TaskRecord {
  const task = createTaskRecordOrNull({
    runtime,
    ownerKey: "agent:main:main",
    scopeKind: "session",
    status: "running",
    deliveryStatus: "not_applicable",
    ...params,
  });
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

export function createAcpTaskRecord(
  params: Omit<TaskFixtureParams, "task"> & { runId: string; task?: string },
): TaskRecord {
  return createTaskFixture("acp", {
    childSessionKey: "agent:main:acp:child",
    task: "Investigate issue",
    deliveryStatus: "pending",
    ...params,
  });
}

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
