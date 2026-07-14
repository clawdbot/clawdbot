// Internal task registry facade used by runtime modules without exposing public SDK surface.
import {
  ensureTaskFlowRegistryReady,
  reloadTaskFlowRegistryFromStore,
} from "./task-flow-runtime-internal.js";
import {
  ensureTaskRegistryReady as ensureTaskRegistryReadyInternal,
  reloadTaskRegistryFromStore as reloadTaskRegistryFromStoreInternal,
} from "./task-registry.js";

export function ensureTaskRuntimeStateReady(): void {
  ensureTaskFlowRegistryReady();
  ensureTaskRegistryReadyInternal();
}

export function reloadTaskRuntimeStateFromStore(): void {
  reloadTaskFlowRegistryFromStore();
  reloadTaskRegistryFromStoreInternal();
}

export {
  assertTaskCancellationReadyById,
  cancelTaskById,
  createTaskRecord,
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  findTaskByRunId,
  finalizeTaskRunByRunId,
  getTaskById,
  hasActiveTaskForChildSessionKey,
  listFreshTasksForOwnerKey,
  listTaskRecords,
  listTaskRecordsUnsorted,
  listTasksForFlowId,
  listTasksForOwnerKey,
  linkTaskToFlowById,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalById,
  maybeDeliverTaskTerminalUpdate,
  recordTaskProgressByRunId,
  resolveTaskForLookupToken,
  resetTaskRegistryForTests,
  isParentFlowLinkError,
  setTaskCleanupAfterById,
  setTaskRunDeliveryStatusByRunId,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
export type { TaskRecord } from "./task-registry.types.js";
