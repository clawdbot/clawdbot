import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { sanitizeUserFacingText } from "../agents/pi-embedded-helpers/sanitize-user-facing-text.js";
import { truncateUtf16Safe } from "../utils.js";
import type { TaskRecord } from "./task-registry.types.js";

const ACTIVE_TASK_STATUSES = new Set(["queued", "running"]);
const FAILURE_TASK_STATUSES = new Set(["failed", "timed_out", "lost"]);
export const TASK_STATUS_RECENT_WINDOW_MS = 5 * 60_000;
export const TASK_STATUS_TITLE_MAX_CHARS = 80;
export const TASK_STATUS_DETAIL_MAX_CHARS = 120;

function isActiveTask(task: TaskRecord): boolean {
  return ACTIVE_TASK_STATUSES.has(task.status);
}

function isFailureTask(task: TaskRecord): boolean {
  return FAILURE_TASK_STATUSES.has(task.status);
}

function resolveTaskReferenceAt(task: TaskRecord): number {
  if (isActiveTask(task)) {
    return task.lastEventAt ?? task.startedAt ?? task.createdAt;
  }
  return task.endedAt ?? task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

function isExpiredTask(task: TaskRecord, now: number): boolean {
  return typeof task.cleanupAfter === "number" && task.cleanupAfter <= now;
}

function isRecentTerminalTask(task: TaskRecord, now: number): boolean {
  if (isActiveTask(task)) {
    return false;
  }
  return now - resolveTaskReferenceAt(task) <= TASK_STATUS_RECENT_WINDOW_MS;
}

function truncateTaskStatusText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stripInlineLeakedInternalContext(value: string): string {
  const beginIndex = value.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN);
  if (
    beginIndex !== -1 &&
    (value.includes(INTERNAL_RUNTIME_CONTEXT_END) ||
      value.includes("OpenClaw runtime context (internal):") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, beginIndex);
  }
  const legacyHeaderIndex = value.indexOf("OpenClaw runtime context (internal):");
  if (
    legacyHeaderIndex !== -1 &&
    (value.includes("Keep internal details private.") ||
      value.includes("[Internal task completion event]"))
  ) {
    return value.slice(0, legacyHeaderIndex);
  }
  return value;
}

function sanitizeTaskStatusValue(value: unknown, errorContext: boolean): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeUserFacingText(stripInlineLeakedInternalContext(value), {
      errorContext,
    })
      .replace(/\s+/g, " ")
      .trim();
    return sanitized || undefined;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => sanitizeTaskStatusValue(entry, errorContext))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (value && typeof value === "object") {
    const nextEntries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeTaskStatusValue(entry, errorContext)] as const)
      .filter(([, entry]) => entry !== undefined);
    if (nextEntries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(nextEntries);
  }
  return value;
}

export function sanitizeTaskStatusText(
  value: unknown,
  opts?: { errorContext?: boolean; maxChars?: number },
): string {
  const errorContext = opts?.errorContext ?? false;
  const sanitizedValue = sanitizeTaskStatusValue(value, errorContext);
  const raw =
    typeof sanitizedValue === "string"
      ? sanitizedValue
      : sanitizedValue == null
        ? ""
        : (JSON.stringify(sanitizedValue) ?? "");
  const sanitized = raw.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return "";
  }
  if (typeof opts?.maxChars === "number") {
    return truncateTaskStatusText(sanitized, opts.maxChars);
  }
  return sanitized;
}

export function formatTaskStatusTitleText(value: unknown, fallback = "Background task"): string {
  return sanitizeTaskStatusText(value, { maxChars: TASK_STATUS_TITLE_MAX_CHARS }) || fallback;
}

export function formatTaskStatusTitle(task: TaskRecord): string {
  return formatTaskStatusTitleText(task.label?.trim() || task.task.trim());
}

export function formatTaskStatusDetail(task: TaskRecord): string | undefined {
  if (task.status === "running" || task.status === "queued") {
    return (
      sanitizeTaskStatusText(task.progressSummary, { maxChars: TASK_STATUS_DETAIL_MAX_CHARS }) ||
      undefined
    );
  }

  const sanitizedError = sanitizeTaskStatusText(task.error, {
    errorContext: true,
    maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
  });
  if (sanitizedError) {
    return sanitizedError;
  }

  return (
    sanitizeTaskStatusText(task.terminalSummary, {
      errorContext: true,
      maxChars: TASK_STATUS_DETAIL_MAX_CHARS,
    }) || undefined
  );
}

export type TaskStatusSnapshot = {
  latest?: TaskRecord;
  focus?: TaskRecord;
  visible: TaskRecord[];
  active: TaskRecord[];
  recentTerminal: TaskRecord[];
  activeCount: number;
  totalCount: number;
  recentFailureCount: number;
};

export function buildTaskStatusSnapshot(
  tasks: TaskRecord[],
  opts?: { now?: number },
): TaskStatusSnapshot {
  const now = opts?.now ?? Date.now();
  const visibleCandidates = tasks.filter((task) => !isExpiredTask(task, now));
  const active = visibleCandidates.filter(isActiveTask);
  const recentTerminal = visibleCandidates.filter((task) => isRecentTerminalTask(task, now));
  const visible = active.length > 0 ? [...active, ...recentTerminal] : recentTerminal;
  const focus =
    active[0] ?? recentTerminal.find((task) => isFailureTask(task)) ?? recentTerminal[0];
  return {
    latest: active[0] ?? recentTerminal[0],
    focus,
    visible,
    active,
    recentTerminal,
    activeCount: active.length,
    totalCount: visible.length,
    recentFailureCount: recentTerminal.filter(isFailureTask).length,
  };
}
