import { resolveGlobalSet } from "../shared/global-singleton.js";
import type { TaskRecord } from "./task-registry.types.js";

export const CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";

const ACTIVE_CONTEXT_ENGINE_MAINTENANCE_TASK_IDS = Symbol.for(
  "openclaw.contextEngineMaintenanceTaskIds",
);

function getActiveContextEngineMaintenanceTaskIds(): Set<string> {
  return resolveGlobalSet<string>(ACTIVE_CONTEXT_ENGINE_MAINTENANCE_TASK_IDS, "close-only");
}

export function isContextEngineTurnMaintenanceTask(
  task: Pick<TaskRecord, "runtime" | "taskKind">,
): boolean {
  return task.runtime === "acp" && task.taskKind === CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND;
}

export function registerContextEngineMaintenanceTaskOwner(taskId: string): () => void {
  const activeTaskIds = getActiveContextEngineMaintenanceTaskIds();
  activeTaskIds.add(taskId);
  return () => activeTaskIds.delete(taskId);
}

export function isContextEngineMaintenanceTaskOwnerActive(taskId: string): boolean {
  return getActiveContextEngineMaintenanceTaskIds().has(taskId);
}
