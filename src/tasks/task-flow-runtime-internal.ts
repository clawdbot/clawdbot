// Internal task-flow registry facade for runtime modules.
export {
  createTaskFlowForTask,
  createManagedTaskFlow,
  deleteTaskFlowRecordById,
  ensureTaskFlowRegistryReady,
  failFlow,
  finishFlow,
  getTaskFlowById,
  listTaskFlowsForOwnerKey,
  listTaskFlowRecords,
  requestFlowCancel,
  reloadTaskFlowRegistryFromStore,
  resolveTaskFlowForLookupToken,
  resetTaskFlowRegistryForTests,
  resumeFlow,
  setFlowWaiting,
  syncFlowFromTask,
  syncFlowFromTaskResult,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";

export type { TaskFlowSyncResult, TaskFlowUpdateResult } from "./task-flow-registry.js";
