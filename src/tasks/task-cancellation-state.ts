// Defines task states that still participate in flow cancellation.
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import type { TaskRecord } from "./task-registry.types.js";

export function isProvisionalSubagentKillTask(
  task: Pick<TaskRecord, "runtime" | "status" | "error">,
): boolean {
  return (
    task.runtime === "subagent" &&
    task.status === "cancelled" &&
    task.error === SUBAGENT_KILL_TASK_ERROR
  );
}

export function isTaskFlowCancellationPending(
  task: Pick<TaskRecord, "runtime" | "status" | "error">,
): boolean {
  return (
    task.status === "queued" || task.status === "running" || isProvisionalSubagentKillTask(task)
  );
}
