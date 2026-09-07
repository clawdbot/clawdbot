// Shared identity for background exec rows in the durable task ledger.
export const BACKGROUND_EXEC_TASK_KIND = "exec";

export function isBackgroundExecTask(task: { runtime: string; taskKind?: string }): boolean {
  return task.runtime === "cli" && task.taskKind === BACKGROUND_EXEC_TASK_KIND;
}
