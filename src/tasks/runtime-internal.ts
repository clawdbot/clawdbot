// Internal task registry facade used by runtime modules without exposing public SDK surface.
import {
  ensureTaskFlowRegistryReady,
  ensureTaskFlowRegistryReadyForInspection,
  reloadTaskFlowRegistryFromStore,
} from "./task-flow-runtime-internal.js";
import {
  ensureTaskRegistryReady as ensureTaskRegistryReadyInternal,
  ensureTaskRegistryReadyForInspection,
  reloadTaskRegistryFromStore as reloadTaskRegistryFromStoreInternal,
} from "./task-registry-state.js";

export function ensureTaskRuntimeStateReady(): void {
  ensureTaskFlowRegistryReady();
  ensureTaskRegistryReadyInternal();
}

export function ensureTaskRuntimeStateReadyForInspection(): void {
  ensureTaskFlowRegistryReadyForInspection();
  ensureTaskRegistryReadyForInspection();
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
  finalizeTaskRecordByRunId,
  getTaskById,
  hasActiveTaskForChildSessionKey,
  listFreshTasksForOwnerKey,
  listTaskRecordPage,
  listTaskRecords,
  listTaskRecordsUnsorted,
  listTasksForFlowId,
  listTasksForOwnerKey,
  linkTaskToFlowById,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalById,
  maybeDeliverTaskTerminalUpdate,
  publishTaskRecordAfterAtomicStore,
  recordTaskProgressByRunId,
  resolveTaskForLookupToken,
  isParentFlowLinkError,
  setTaskCleanupAfterById,
  setTaskRunDeliveryStatusByRunId,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
export type { TaskRecord } from "./task-registry.types.js";
