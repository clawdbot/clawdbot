// Public task registry surface. Runtime ownership is split across focused modules.
import "./task-registry-lifecycle.js";
import { maybeDeliverTaskStateChangeUpdate } from "./task-registry-delivery.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "./task-registry-query.js";

export { isParentFlowLinkError } from "./task-registry-common.js";
export { assertTaskCancellationReadyById, cancelTaskById } from "./task-registry-cancel.js";
export { maybeDeliverTaskTerminalUpdate } from "./task-registry-delivery.js";
export {
  createTaskRecord,
  finalizeTaskRunByRunId,
  linkTaskToFlowById,
  markTaskLostById,
  markTaskRunningByRunId,
  markTaskTerminalById,
  recordTaskProgressByRunId,
  setTaskCleanupAfterById,
  setTaskRunDeliveryStatusByRunId,
  updateTaskNotifyPolicyById,
} from "./task-registry-record-api.js";
export {
  deleteTaskRecordById,
  findTaskByRunId,
  getTaskById,
  hasActiveTaskForChildSessionKey,
  listFreshTasksForOwnerKey,
  listTaskRecords,
  listTaskRecordsUnsorted,
  listTasksForAgentId,
  listTasksForFlowId,
  listTasksForOwnerKey,
  listTasksForRelatedSessionKey,
  listTasksForSessionKey,
  resolveTaskForLookupToken,
} from "./task-registry-query.js";
export { ensureTaskRegistryReady, reloadTaskRegistryFromStore } from "./task-registry-state.js";

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.taskRegistryTestApi")] = {
    maybeDeliverTaskStateChangeUpdate,
    resetTaskRegistryControlRuntimeForTests,
    resetTaskRegistryDeliveryRuntimeForTests,
    resetTaskRegistryForTests,
    setTaskRegistryControlRuntimeForTests,
    setTaskRegistryDeliveryRuntimeForTests,
  };
}
