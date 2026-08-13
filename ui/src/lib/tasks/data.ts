import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as optionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import {
  TasksCancelResultSchema,
  TasksGetResultSchema,
  TasksListResultSchema,
  TasksRecoveryResultSchema,
} from "../../../../packages/gateway-protocol/src/schema/tasks.js";
import type {
  TasksCancelResult,
  TasksRecoveryResult,
} from "../../../../packages/gateway-protocol/src/schema/tasks.js";
import { t } from "../../i18n/index.ts";
import { normalizeTaskSummary, type TaskStatus, type TaskSummary } from "./task-summary.ts";

type TaskTimestamp = NonNullable<TaskSummary["updatedAt"]>;

type TaskEventPayload =
  | { action: "upserted"; task: TaskSummary }
  | { action: "deleted"; taskId: string }
  | { action: "restored" };

const STATUS_LABEL_KEYS = {
  queued: "tasksPage.status.queued",
  running: "tasksPage.status.running",
  completed: "tasksPage.status.completed",
  failed: "tasksPage.status.failed",
  cancelled: "tasksPage.status.cancelled",
  timed_out: "tasksPage.status.timedOut",
} as const satisfies Record<TaskStatus, string>;

const STATUS_CHIP_CLASSES = {
  queued: "chip-warn",
  running: "chip-warn",
  completed: "chip-ok",
  failed: "chip-danger",
  cancelled: "",
  timed_out: "chip-danger",
} as const satisfies Record<TaskStatus, string>;

export function taskStatusLabel(status: TaskStatus): string {
  return t(STATUS_LABEL_KEYS[status]);
}

export function taskStatusChipClass(status: TaskStatus): string {
  return STATUS_CHIP_CLASSES[status];
}

export function taskRuntimeLabel(task: TaskSummary): string {
  switch (task.runtime) {
    case "subagent":
      return t("tasksPage.runtime.subagent");
    case "cron":
      return t("tasksPage.runtime.cron");
    case "acp":
      return t("tasksPage.runtime.acp");
    case "cli":
      return t("tasksPage.runtime.cli");
    default:
      return t("tasksPage.runtime.unknown");
  }
}

export function taskTitle(task: TaskSummary): string {
  return (
    task.title ?? task.kind ?? (task.runtime ? taskRuntimeLabel(task) : t("tasksPage.untitled"))
  );
}

export function taskDetail(task: TaskSummary): string | null {
  if (task.status === "queued" || task.status === "running") {
    return task.progressSummary ?? null;
  }
  if (task.status === "failed" || task.status === "timed_out") {
    return task.error ?? task.terminalSummary ?? task.progressSummary ?? null;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? null;
}

export function isActiveTask(task: TaskSummary): boolean {
  return task.status === "queued" || task.status === "running";
}

export function taskTimestampMs(value: TaskTimestamp | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

type TaskSnapshotProvenance = "snapshot" | "event" | "detail";

function preserveTaskPrompt(
  selected: TaskSummary,
  current: TaskSummary,
  lookup: TaskSummary,
): TaskSummary {
  const prompt = lookup.prompt ?? current.prompt;
  return prompt && selected.prompt !== prompt ? { ...selected, prompt } : selected;
}

export function newestTaskSnapshot(
  current: TaskSummary,
  lookup: TaskSummary | undefined,
  provenance: TaskSnapshotProvenance = "detail",
): TaskSummary {
  if (!lookup) {
    return current;
  }
  const currentAt = taskTimestampMs(current.updatedAt ?? current.endedAt ?? current.createdAt);
  const lookupAt = taskTimestampMs(lookup.updatedAt ?? lookup.endedAt ?? lookup.createdAt);
  if (lookupAt > currentAt) {
    return preserveTaskPrompt(lookup, current, lookup);
  }
  if (lookupAt < currentAt) {
    return current;
  }
  // Millisecond clocks collide under load. Ordered pages and events advance
  // active work; only events correct terminal output, and details stay stale-safe.
  const currentActive = isActiveTask(current);
  const lookupActive = isActiveTask(lookup);
  if (currentActive !== lookupActive) {
    return preserveTaskPrompt(currentActive ? lookup : current, current, lookup);
  }
  if (!currentActive) {
    return provenance === "event" ? preserveTaskPrompt(lookup, current, lookup) : current;
  }
  if (current.status === "running" && lookup.status === "queued") {
    return preserveTaskPrompt(current, current, lookup);
  }
  if (current.status === "queued" && lookup.status === "running") {
    return preserveTaskPrompt(lookup, current, lookup);
  }
  const currentToolCount = current.toolUseCount ?? 0;
  const lookupToolCount = lookup.toolUseCount ?? 0;
  if (currentToolCount > lookupToolCount) {
    return preserveTaskPrompt(current, current, lookup);
  }
  if (lookupToolCount > currentToolCount || provenance !== "detail") {
    return preserveTaskPrompt(lookup, current, lookup);
  }
  return preserveTaskPrompt(current, current, lookup);
}

export function sortTasks(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.toSorted((left, right) => {
    const timeDelta = taskTimestampMs(right.updatedAt) - taskTimestampMs(left.updatedAt);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

export function partitionTasks(tasks: readonly TaskSummary[]): {
  active: TaskSummary[];
  recent: TaskSummary[];
} {
  const sorted = sortTasks(tasks);
  return {
    active: sorted.filter((task) => task.status === "queued" || task.status === "running"),
    recent: sorted
      .filter((task) => task.status !== "queued" && task.status !== "running")
      .slice(0, 50),
  };
}

export function normalizeTasksListResult(
  value: unknown,
): { tasks: TaskSummary[]; nextCursor?: string } | null {
  if (!Value.Check(TasksListResultSchema, value)) {
    return null;
  }
  return {
    tasks: sortTasks(
      value.tasks.map(normalizeTaskSummary).filter((task): task is TaskSummary => task !== null),
    ),
    ...(value.nextCursor !== undefined ? { nextCursor: value.nextCursor } : {}),
  };
}

export function normalizeTasksGetResult(value: unknown): TaskSummary | null {
  if (!Value.Check(TasksGetResultSchema, value)) {
    return null;
  }
  return normalizeTaskSummary(value.task);
}

// The ledger pages newest-first, so one page can hide long-running tasks behind
// newer terminal records; callers fetch active tasks separately and merge here.
export function mergeTaskLists(...lists: readonly (readonly TaskSummary[])[]): TaskSummary[] {
  const byId = new Map<string, TaskSummary>();
  for (const list of lists) {
    for (const task of list) {
      const current = byId.get(task.id);
      byId.set(task.id, current ? newestTaskSnapshot(current, task, "snapshot") : task);
    }
  }
  return sortTasks([...byId.values()]);
}

// Cancellation refusals (already-terminal, missing handle, stale id) arrive as
// successful responses with cancelled=false + reason, not thrown errors.
type NormalizedTasksCancelResult = Omit<TasksCancelResult, "task"> & { task?: TaskSummary };

export function normalizeTasksCancelResult(value: unknown): NormalizedTasksCancelResult | null {
  if (!Value.Check(TasksCancelResultSchema, value)) {
    return null;
  }
  const reason = optionalString(value.reason);
  const task = normalizeTaskSummary(value.task);
  return {
    found: value.found,
    cancelled: value.cancelled,
    ...(reason ? { reason } : {}),
    ...(task ? { task } : {}),
  };
}

type NormalizedTasksRecoveryResult = Omit<TasksRecoveryResult, "results"> & {
  results: Array<Omit<TasksRecoveryResult["results"][number], "task"> & { task?: TaskSummary }>;
};

export function normalizeTasksRecoveryResult(value: unknown): NormalizedTasksRecoveryResult | null {
  if (!Value.Check(TasksRecoveryResultSchema, value)) {
    return null;
  }
  return {
    results: value.results.map((result) => {
      const task = normalizeTaskSummary(result.task);
      const { task: _wireTask, ...rest } = result;
      return { ...rest, ...(task ? { task } : {}) };
    }),
  };
}

export function normalizeTaskEventPayload(value: unknown): TaskEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.action === "restored") {
    return { action: "restored" };
  }
  if (value.action === "deleted") {
    const taskId = optionalString(value.taskId);
    return taskId ? { action: "deleted", taskId } : null;
  }
  if (value.action === "upserted") {
    const task = normalizeTaskSummary(value.task);
    return task ? { action: "upserted", task } : null;
  }
  return null;
}

export function applyTaskEvent(
  tasks: readonly TaskSummary[],
  value: unknown,
): { tasks: TaskSummary[]; refetch: boolean } {
  const event = normalizeTaskEventPayload(value);
  if (!event || event.action === "restored") {
    return { tasks: [...tasks], refetch: true };
  }
  if (event.action === "deleted") {
    return {
      tasks: sortTasks(tasks.filter((task) => task.id !== event.taskId)),
      refetch: false,
    };
  }
  const current = tasks.find((task) => task.id === event.task.id);
  const next = current ? newestTaskSnapshot(current, event.task, "event") : event.task;
  return {
    tasks: sortTasks([next, ...tasks.filter((task) => task.id !== event.task.id)]),
    refetch: false,
  };
}
