import { parseStreamingJson } from "@openclaw/ai/internal/runtime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveFileMutationToolName, type FileMutationToolName } from "./tool-mutation-names.js";

const LIVE_EDIT_DIFF_MIN_INTERVAL_MS = 250;
const LIVE_EDIT_DIFF_MAX_PARTIAL_JSON_CHARS = 1024 * 1024;
const LIVE_EDIT_DIFF_MAX_TRACKED_CALLS = 64;

type LiveEditDiffProgressState = {
  added: number;
  removed: number;
  emittedAdded: number;
  emittedRemoved: number;
  lastCheckedAtMs: number;
};

type LiveEditDiffProgress = {
  toolCallId: string;
  name: string;
  diff: { added: number; removed: number };
};

function countNewlines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  let count = 0;
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

function countEditLines(args: Record<string, unknown>): { added: number; removed: number } {
  const replacements = Array.isArray(args.edits) ? args.edits : [args];
  let added = 0;
  let removed = 0;
  for (const replacement of replacements) {
    if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) {
      continue;
    }
    const record = replacement as Record<string, unknown>;
    added += countNewlines(record.newText ?? record.new_string);
    removed += countNewlines(record.oldText ?? record.old_string);
  }
  return { added, removed };
}

function countPatchLines(patch: unknown): { added: number; removed: number } {
  if (typeof patch !== "string") {
    return { added: 0, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  let lineStart = 0;
  for (let lineEnd = patch.indexOf("\n"); lineEnd >= 0; lineEnd = patch.indexOf("\n", lineStart)) {
    if (patch[lineStart] === "+") {
      added += 1;
    } else if (patch[lineStart] === "-") {
      removed += 1;
    }
    lineStart = lineEnd + 1;
  }
  return { added, removed };
}

function countLiveEditDiff(
  kind: FileMutationToolName,
  args: Record<string, unknown>,
): { added: number; removed: number } {
  if (kind === "write") {
    return { added: countNewlines(args.content), removed: 0 };
  }
  if (kind === "edit") {
    return countEditLines(args);
  }
  return countPatchLines(args.input ?? args.patch);
}

function readToolCallBlock(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const contentIndex = event.contentIndex;
  const partial = event.partial;
  if (
    typeof contentIndex !== "number" ||
    !Number.isInteger(contentIndex) ||
    contentIndex < 0 ||
    !partial ||
    typeof partial !== "object"
  ) {
    return undefined;
  }
  const content = (partial as { content?: unknown }).content;
  const block = Array.isArray(content) ? content[contentIndex] : undefined;
  return block && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : undefined;
}

function readToolCallId(event: Record<string, unknown>): string | undefined {
  const toolCall = event.toolCall;
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const id = (toolCall as Record<string, unknown>).id;
    if (typeof id === "string" && id) {
      return id;
    }
  }
  const block = readToolCallBlock(event);
  return typeof block?.id === "string" && block.id ? block.id : undefined;
}

/** Update one run's bounded best-effort diff counters from a model stream event. */
export function updateLiveEditDiffProgress(
  stateByToolCallId: Map<string, LiveEditDiffProgressState>,
  event: Record<string, unknown> | undefined,
): LiveEditDiffProgress | undefined {
  if (!event) {
    return undefined;
  }
  const eventType = event.type;
  if (eventType === "toolcall_end") {
    const toolCallId = readToolCallId(event);
    if (toolCallId) {
      stateByToolCallId.delete(toolCallId);
    }
    return undefined;
  }
  if (eventType !== "toolcall_delta") {
    return undefined;
  }

  const block = readToolCallBlock(event);
  const toolCallId = typeof block?.id === "string" ? block.id : "";
  const name = typeof block?.name === "string" ? block.name : "";
  const kind = resolveFileMutationToolName(name);
  const partialJson = typeof block?.partialJson === "string" ? block.partialJson : "";
  if (!toolCallId || !kind || !partialJson) {
    return undefined;
  }
  if (partialJson.length > LIVE_EDIT_DIFF_MAX_PARTIAL_JSON_CHARS) {
    stateByToolCallId.delete(toolCallId);
    return undefined;
  }

  let progress = stateByToolCallId.get(toolCallId);
  if (!progress) {
    if (stateByToolCallId.size >= LIVE_EDIT_DIFF_MAX_TRACKED_CALLS) {
      return undefined;
    }
    progress = { added: 0, removed: 0, emittedAdded: 0, emittedRemoved: 0, lastCheckedAtMs: 0 };
    stateByToolCallId.set(toolCallId, progress);
  }

  const now = Date.now();
  if (
    progress.lastCheckedAtMs > 0 &&
    now - progress.lastCheckedAtMs < LIVE_EDIT_DIFF_MIN_INTERVAL_MS
  ) {
    return undefined;
  }
  // Parsing is the expensive part. Rate-limit it before touching cumulative JSON
  // so fragmented large arguments cannot create quadratic work on the event path.
  progress.lastCheckedAtMs = now;
  const counted = countLiveEditDiff(kind, parseStreamingJson(partialJson));
  // Streaming parses are best effort. Never move a visible counter backwards if
  // an incomplete JSON boundary temporarily exposes less of the same arguments.
  progress.added = Math.max(progress.added, counted.added);
  progress.removed = Math.max(progress.removed, counted.removed);
  if (progress.added === progress.emittedAdded && progress.removed === progress.emittedRemoved) {
    return undefined;
  }
  progress.emittedAdded = progress.added;
  progress.emittedRemoved = progress.removed;
  return {
    toolCallId,
    name: normalizeLowercaseStringOrEmpty(name),
    diff: { added: progress.added, removed: progress.removed },
  };
}
