import type { TaskRecord } from "./task-registry.types.js";

// Agent harnesses stamp taskKind at row creation through the agent-harness task runtime.
// With no OpenClaw child session, these tasks cannot be recovered or cancelled through one.
export function isHarnessOwnedSubagentTask(task: TaskRecord): boolean {
  return (
    task.runtime === "subagent" && !task.childSessionKey?.trim() && Boolean(task.taskKind?.trim())
  );
}
