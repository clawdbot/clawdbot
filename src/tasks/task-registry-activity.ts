import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readCompletedFileMutationDelta } from "../agents/file-mutation-args.js";
import { resolveFileMutationToolName } from "../agents/tool-mutation-names.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { isTerminalTaskStatus } from "./task-executor-policy.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import {
  emitTaskRegistryObserverEvent,
  taskActivityByTaskId,
  tasks,
} from "./task-registry-state.js";
import type { TaskActivityOverlayState } from "./task-registry.process-state.js";
import type { TaskRecord } from "./task-registry.types.js";

const MAX_ACTIVITY_CHARS = 200;
const ACTIVITY_LINE_PREFIX = new RegExp(`^(?:\\s*\\S){1,${MAX_ACTIVITY_CHARS + 1}}`);
const STREAM_TEXT_BUFFER_CHARS = 4_000;
const ACTIVITY_FLUSH_MS = 1_000;
const MAX_PENDING_DIFFS = 64;

type TaskActivitySnapshot = {
  lastActivity?: string;
  diffStat?: { files: number; added: number; removed: number };
};

function activityFor(task: TaskRecord): TaskActivityOverlayState {
  const runId = task.runId ?? "";
  const existing = taskActivityByTaskId.get(task.taskId);
  if (existing?.runId === runId) {
    return existing;
  }
  if (existing?.flushTimer) {
    clearTimeout(existing.flushTimer);
  }
  const created: TaskActivityOverlayState = {
    runId,
    assistantText: "",
    thinkingText: "",
    hasAssistantActivity: false,
    files: new Set(),
    added: 0,
    removed: 0,
    pendingDiffByToolCallId: new Map(),
    dirty: false,
  };
  taskActivityByTaskId.set(task.taskId, created);
  return created;
}

function lastLineSnippet(text: string): string | undefined {
  const line = text
    .trimEnd()
    .split(/\r\n|\r|\n/)
    .at(-1);
  // Normalize only the prefix; the extra nonspace unit preserves a surrogate pair
  // crossing the truncation boundary without copying the whole growing line.
  const prefix = line?.match(ACTIVITY_LINE_PREFIX)?.[0];
  return prefix
    ? truncateUtf16Safe(prefix.replace(/\s+/g, " ").trim(), MAX_ACTIVITY_CHARS)
    : undefined;
}

function scheduleFlush(taskId: string, activity: TaskActivityOverlayState): void {
  if (activity.flushTimer) {
    return;
  }
  const elapsed = activity.lastFlushedAt === undefined ? 0 : Date.now() - activity.lastFlushedAt;
  const delay = Math.max(0, ACTIVITY_FLUSH_MS - elapsed);
  activity.flushTimer = setTimeout(() => {
    activity.flushTimer = undefined;
    flushTaskActivity(taskId);
  }, delay);
  activity.flushTimer.unref?.();
}

function markChanged(taskId: string, activity: TaskActivityOverlayState): void {
  activity.dirty = true;
  scheduleFlush(taskId, activity);
}

/** Folds streaming-only fields and returns true when durable task mutation should be skipped. */
export function recordTaskActivityEvent(task: TaskRecord, event: AgentEventPayload): boolean {
  const textStream = event.stream;
  if (textStream === "assistant" || textStream === "thinking") {
    const activity = activityFor(task);
    if (textStream === "thinking" && activity.hasAssistantActivity) {
      return true;
    }
    const key = textStream === "assistant" ? "assistantText" : "thinkingText";
    let cumulative: string;
    if (typeof event.data.text === "string") {
      cumulative = event.data.text;
    } else if (typeof event.data.delta === "string") {
      cumulative = activity[key] + event.data.delta;
    } else {
      return true;
    }
    // Retain only a suffix for delta-only producers; full snapshots remain authoritative.
    activity[key] = sliceUtf16Safe(cumulative, -STREAM_TEXT_BUFFER_CHARS);
    const snippet = lastLineSnippet(cumulative);
    if (!snippet) {
      return true;
    }
    if (textStream === "assistant") {
      activity.hasAssistantActivity = true;
      activity.thinkingText = "";
    }
    if (activity.lastActivity !== snippet) {
      activity.lastActivity = snippet;
      markChanged(task.taskId, activity);
    }
    return true;
  }

  if (event.stream !== "tool") {
    return false;
  }
  const toolName = typeof event.data.name === "string" ? event.data.name : "";
  const kind = resolveFileMutationToolName(toolName);
  if (!kind) {
    return false;
  }
  const toolCallId = normalizeOptionalString(event.data.toolCallId);
  if (event.data.phase === "start") {
    const args = asOptionalObjectRecord(event.data.args);
    const delta = args ? readCompletedFileMutationDelta(kind, args) : undefined;
    if (!toolCallId || !delta) {
      return false;
    }
    const activity = activityFor(task);
    if (
      !activity.pendingDiffByToolCallId.has(toolCallId) &&
      activity.pendingDiffByToolCallId.size >= MAX_PENDING_DIFFS
    ) {
      return false;
    }
    activity.pendingDiffByToolCallId.set(toolCallId, delta);
    return false;
  }
  if (event.data.phase !== "result") {
    return false;
  }
  const activity = taskActivityByTaskId.get(task.taskId);
  const delta = toolCallId ? activity?.pendingDiffByToolCallId.get(toolCallId) : undefined;
  if (toolCallId) {
    activity?.pendingDiffByToolCallId.delete(toolCallId);
  }
  if (event.data.isError === true || !delta || !activity) {
    return event.data.isError !== true;
  }
  let changed = delta.added > 0 || delta.removed > 0;
  for (const file of delta.files) {
    const size = activity.files.size;
    activity.files.add(file);
    changed ||= activity.files.size !== size;
  }
  if (changed) {
    activity.added += delta.added;
    activity.removed += delta.removed;
    markChanged(task.taskId, activity);
  }
  return true;
}

export function getTaskActivitySnapshot(taskId: string): TaskActivitySnapshot | undefined {
  const activity = taskActivityByTaskId.get(taskId);
  return activity
    ? {
        ...(activity.lastActivity ? { lastActivity: activity.lastActivity } : {}),
        ...(activity.files.size > 0
          ? {
              diffStat: {
                files: activity.files.size,
                added: activity.added,
                removed: activity.removed,
              },
            }
          : {}),
      }
    : undefined;
}

export function flushTaskActivity(taskId: string): void {
  const activity = taskActivityByTaskId.get(taskId);
  if (!activity?.dirty) {
    return;
  }
  if (activity.flushTimer) {
    clearTimeout(activity.flushTimer);
    activity.flushTimer = undefined;
  }
  const task = tasks.get(taskId);
  if (!task || isTerminalTaskStatus(task.status)) {
    clearTaskActivity(taskId);
    return;
  }
  activity.dirty = false;
  activity.lastFlushedAt = Date.now();
  emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: cloneTaskRecord(task) }));
}

export function clearTaskActivity(taskId: string): void {
  const activity = taskActivityByTaskId.get(taskId);
  if (activity?.flushTimer) {
    clearTimeout(activity.flushTimer);
  }
  taskActivityByTaskId.delete(taskId);
}
