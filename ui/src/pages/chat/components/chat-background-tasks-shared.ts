import { t } from "../../../i18n/index.ts";
import { isActiveTask, taskStatusLabel, type TaskSummary } from "../../../lib/tasks/data.ts";

export { newestTaskSnapshot } from "../../../lib/tasks/data.ts";

// Status tone drives the meta line's colored word and the running pulse dot;
// pill chips read too heavy at rail width, so tone is typographic only.
// Shared with the status row's hover preview.
export const STATUS_TONES = {
  queued: "warn",
  running: "warn",
  completed: "ok",
  failed: "danger",
  cancelled: "danger",
  timed_out: "danger",
} as const satisfies Record<TaskSummary["status"], string>;

export function backgroundTaskStatusLabel(task: TaskSummary): string {
  if (isActiveTask(task)) {
    return taskStatusLabel(task.status);
  }
  // Finished history intentionally has two outcomes: completed or failed.
  // Cancellation and timeout stay grouped as unsuccessful work.
  return task.status === "completed"
    ? t("tasksPage.status.completed")
    : t("tasksPage.status.failed");
}
