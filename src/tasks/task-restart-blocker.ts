// Shared formatting contract for restart diagnostics that report active tasks.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

export type ActiveTaskRestartBlocker = {
  taskId: string;
  status: Extract<TaskStatus, "running">;
  runtime: TaskRecord["runtime"];
  runId?: string;
  label?: string;
  title?: string;
};

export function formatActiveTaskRestartBlocker(task: ActiveTaskRestartBlocker): string {
  return [
    `taskId=${task.taskId}`,
    task.runId ? `runId=${task.runId}` : null,
    `status=${task.status}`,
    `runtime=${task.runtime}`,
    task.label ? `label=${task.label}` : null,
    task.title ? `title=${truncateUtf16Safe(task.title, 80)}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}
