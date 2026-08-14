import { parseStreamingJson } from "@openclaw/ai/internal/runtime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { countStreamingFileMutationLines } from "./file-mutation-args.js";
import { resolveFileMutationToolName } from "./tool-mutation-names.js";

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
  const counted = countStreamingFileMutationLines(kind, parseStreamingJson(partialJson));
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
