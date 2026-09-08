import type {
  JsonValue,
  TaskFlowRecord,
  TaskFlowStatus,
  TaskFlowSyncMode,
} from "./task-flow-registry.types.js";
import "./task-flow-registry.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";

type CreateFlowRecordParams = {
  ownerKey: string;
  requesterOrigin?: TaskFlowRecord["requesterOrigin"];
  status?: TaskFlowStatus;
  notifyPolicy?: TaskNotifyPolicy;
  goal: string;
  currentStep?: string | null;
  blockedTaskId?: string | null;
  blockedSummary?: string | null;
  stateJson?: JsonValue | null;
  waitJson?: JsonValue | null;
  cancelRequestedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number | null;
  syncMode?: TaskFlowSyncMode;
  controllerId?: string | null;
  revision?: number;
};

type TaskFlowRegistryTestApi = {
  createFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord | null;
  resetTaskFlowRegistryForTests(opts?: { persist?: boolean }): void;
};

function getTestApi(): TaskFlowRegistryTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.taskFlowRegistryTestApi")
  ];
  if (!api) {
    throw new Error("task flow registry test API is unavailable");
  }
  return api as TaskFlowRegistryTestApi;
}

export function createFlowRecord(params: CreateFlowRecordParams): TaskFlowRecord | null {
  return getTestApi().createFlowRecord(params);
}

export function resetTaskFlowRegistryForTests(opts?: { persist?: boolean }): void {
  getTestApi().resetTaskFlowRegistryForTests(opts);
}
