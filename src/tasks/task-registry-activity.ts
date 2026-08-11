import path from "node:path";
import {
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractApplyPatchTargetPaths } from "../agents/apply-patch-paths.js";
import {
  resolveFileMutationToolName,
  type FileMutationToolName,
} from "../agents/tool-mutation-names.js";
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
const STREAM_TEXT_BUFFER_CHARS = 4_000;
const ACTIVITY_FLUSH_MS = 1_000;
const MAX_PENDING_DIFFS = 64;

type TaskActivitySnapshot = {
  lastActivity?: string;
  diffStat?: { files: number; added: number; removed: number };
};

type DiffDelta = { files: string[]; added: number; removed: number };
type EditPair = { oldText: string; newText: string };

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
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.replace(/\s+/g, " ").trim();
    if (line) {
      return truncateUtf16Safe(line, MAX_ACTIVITY_CHARS);
    }
  }
  return undefined;
}

function updateStreamText(
  activity: TaskActivityOverlayState,
  stream: "assistant" | "thinking",
  data: Record<string, unknown>,
): string | undefined {
  const key = stream === "assistant" ? "assistantText" : "thinkingText";
  let cumulative: string;
  if (typeof data.text === "string") {
    cumulative = data.text;
  } else if (typeof data.delta === "string") {
    cumulative = activity[key] + data.delta;
  } else {
    return undefined;
  }
  // Retain only a suffix for delta-only producers; full snapshots remain authoritative.
  activity[key] = sliceUtf16Safe(cumulative, -STREAM_TEXT_BUFFER_CHARS);
  return lastLineSnippet(cumulative);
}

function readTarget(record: Record<string, unknown>): string | undefined {
  const target = normalizeOptionalString(record.path ?? record.file_path ?? record.filePath);
  return target ? path.resolve(target) : undefined;
}

// Live progress is intentionally a best-effort count from submitted args, not a post-write diff.
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

function readEditPairs(args: Record<string, unknown>): EditPair[] {
  const candidates = Array.isArray(args.edits) ? args.edits : [args];
  const pairs: EditPair[] = [];
  for (const candidate of candidates) {
    const edit = asOptionalObjectRecord(candidate);
    if (!edit) {
      continue;
    }
    const oldText = readStringField(edit, "oldText") ?? readStringField(edit, "old_string");
    const newText = readStringField(edit, "newText") ?? readStringField(edit, "new_string");
    if (oldText !== undefined && newText !== undefined) {
      pairs.push({ oldText, newText });
    }
  }
  return pairs;
}

function readPatchDelta(args: Record<string, unknown>): DiffDelta | undefined {
  if (typeof args.input !== "string") {
    let added = 0;
    let removed = 0;
    const files: string[] = [];
    for (const candidate of Array.isArray(args.changes) ? args.changes : []) {
      const change = asOptionalObjectRecord(candidate);
      const target = change ? readTarget(change) : undefined;
      if (!change || !target) {
        continue;
      }
      files.push(target);
      const stat = asOptionalObjectRecord(change.stat);
      added +=
        typeof stat?.added === "number" && Number.isFinite(stat.added)
          ? Math.max(0, stat.added)
          : 0;
      removed +=
        typeof stat?.removed === "number" && Number.isFinite(stat.removed)
          ? Math.max(0, stat.removed)
          : 0;
    }
    return files.length > 0 ? { files, added, removed } : undefined;
  }
  const files = extractApplyPatchTargetPaths(args);
  if (files.length === 0) {
    return undefined;
  }
  let added = 0;
  let removed = 0;
  let inBody = false;
  for (const line of args.input.split(/\r\n|\r|\n/)) {
    if (/^\s*\*\*\* (?:Add|Update|Delete) File: /.test(line)) {
      inBody = true;
    } else if (!/^\s*\*\* /.test(line) && inBody) {
      added += Number(line.startsWith("+"));
      removed += Number(line.startsWith("-"));
    }
  }
  return { files, added, removed };
}

function readDiffDelta(
  kind: FileMutationToolName,
  args: Record<string, unknown>,
): DiffDelta | undefined {
  if (kind === "apply_patch") {
    return readPatchDelta(args);
  }
  const target = readTarget(args);
  if (!target) {
    return undefined;
  }
  if (kind === "write") {
    return typeof args.content === "string"
      ? { files: [target], added: countLines(args.content), removed: 0 }
      : undefined;
  }
  const pairs = readEditPairs(args);
  return pairs.length > 0
    ? {
        files: [target],
        added: pairs.reduce((total, pair) => total + countLines(pair.newText), 0),
        removed: pairs.reduce((total, pair) => total + countLines(pair.oldText), 0),
      }
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
  const textStream =
    event.stream === "assistant"
      ? "assistant"
      : event.stream === "thinking"
        ? "thinking"
        : undefined;
  if (textStream) {
    const activity = activityFor(task);
    const snippet = updateStreamText(activity, textStream, event.data);
    if (!snippet) {
      return true;
    }
    if (textStream === "assistant") {
      activity.hasAssistantActivity = true;
    } else if (activity.hasAssistantActivity) {
      return true;
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
    const delta = args ? readDiffDelta(kind, args) : undefined;
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
