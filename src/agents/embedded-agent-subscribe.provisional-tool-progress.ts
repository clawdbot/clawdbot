/**
 * Emits throttled provisional `stream: "tool"` events while mutation-tool
 * arguments are still streaming. Real `tool_execution_start` later replaces
 * these with full sanitized args. Surfaces path + a bounded content preview
 * so Control UI can show "Writing foo.md +N" and a live +diff viewport before
 * disk I/O starts. Never emit contentLength — that leaks into KV tool shells.
 */
import { asOptionalObjectRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { emitAgentEvent } from "../infra/agent-events.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentMessage } from "./runtime/index.js";
import { normalizeToolName } from "./tool-policy.js";

// Keep updates frequent enough for a typewriter feel without flooding WS.
const LIVE_PROVISIONAL_TOOL_UPDATE_MIN_INTERVAL_MS = 80;
// Prefer full content when small; otherwise send a trailing window so the
// latest characters stay visible without shipping multi-MB arg payloads.
const PROVISIONAL_CONTENT_PREVIEW_MAX_CHARS = 24_000;

const MUTATION_STREAM_TOOL_NAMES = new Set([
  "write",
  "write_file",
  "create_file",
  "edit",
  "edit_file",
  "multiedit",
  "multi_edit",
  "apply_patch",
  "applypatch",
  "patch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
]);

const CONTENT_LENGTH_ARG_KEYS = [
  "content",
  "newText",
  "new_string",
  "file_text",
  "patch",
  "input",
] as const;

export type ProvisionalToolStreamState = {
  lastEmittedAtMs: number;
  lastContentLength?: number;
  started: boolean;
  lastPath?: string;
};

function resolvePathArg(args: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(args.path) ??
    normalizeOptionalString(args.file_path) ??
    normalizeOptionalString(args.filePath) ??
    normalizeOptionalString(args.file) ??
    normalizeOptionalString(args.filepath) ??
    normalizeOptionalString(args.filename) ??
    normalizeOptionalString(args.notebook_path)
  );
}

function resolveStreamingContentText(args: Record<string, unknown>): string | undefined {
  for (const key of CONTENT_LENGTH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function truncateProvisionalContentPreview(content: string): string {
  if (content.length <= PROVISIONAL_CONTENT_PREVIEW_MAX_CHARS) {
    return content;
  }
  return sliceUtf16Safe(content, -PROVISIONAL_CONTENT_PREVIEW_MAX_CHARS);
}

function resolveStreamingContentLength(args: Record<string, unknown>): number | undefined {
  const explicit = args.contentLength;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const content = resolveStreamingContentText(args);
  if (content) {
    return content.length;
  }
  return undefined;
}

function resolveStreamingToolCallBlock(
  message: AgentMessage,
  contentIndex: unknown,
): { id: string; name: string; arguments: Record<string, unknown> } | undefined {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const index =
    typeof contentIndex === "number" && Number.isInteger(contentIndex) && contentIndex >= 0
      ? contentIndex
      : undefined;
  const candidates = index !== undefined ? [content[index]] : content.filter(Boolean).toReversed();
  for (const block of candidates) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (record.type !== "toolCall" && record.type !== "functionCall") {
      continue;
    }
    const id = normalizeOptionalString(record.id);
    const name = normalizeOptionalString(record.name);
    if (!id || !name) {
      continue;
    }
    const args = asRecord(record.arguments) ?? {};
    return { id, name, arguments: args };
  }
  return undefined;
}

function buildProvisionalMutationArgs(args: Record<string, unknown>): {
  path?: string;
  content?: string;
} {
  const path = resolvePathArg(args);
  const contentText = resolveStreamingContentText(args);
  // Do not ship contentLength — UI derives +N lines from content and must not
  // fall through to a contentLength key/value dump.
  return {
    ...(path ? { path } : {}),
    ...(contentText ? { content: truncateProvisionalContentPreview(contentText) } : {}),
  };
}

function shouldEmitProvisionalUpdate(
  previous: ProvisionalToolStreamState | undefined,
  next: { path?: string; content?: string },
  now: number,
): boolean {
  // toolcall_start / first delta: show Writing/Editing as soon as the tool name
  // is known, even before path/content appear in partial JSON.
  if (!previous?.started) {
    return true;
  }
  if (next.path && previous.lastPath !== next.path) {
    return true;
  }
  const nextLen = next.content?.length;
  if (nextLen !== undefined && nextLen !== previous.lastContentLength) {
    return now - previous.lastEmittedAtMs >= LIVE_PROVISIONAL_TOOL_UPDATE_MIN_INTERVAL_MS;
  }
  return false;
}

/** Emit provisional tool-stream progress for streaming write/edit/patch args. */
export function maybeEmitProvisionalMutationToolProgress(
  ctx: EmbeddedAgentSubscribeContext,
  params: {
    message: AgentMessage;
    assistantMessageEvent?: Record<string, unknown>;
  },
): void {
  const evtType =
    typeof params.assistantMessageEvent?.type === "string" ? params.assistantMessageEvent.type : "";
  if (evtType !== "toolcall_start" && evtType !== "toolcall_delta") {
    return;
  }

  const toolCall = resolveStreamingToolCallBlock(
    params.message,
    params.assistantMessageEvent?.contentIndex,
  );
  if (!toolCall) {
    return;
  }

  const toolName = normalizeToolName(toolCall.name);
  if (!MUTATION_STREAM_TOOL_NAMES.has(toolName)) {
    return;
  }

  // Real execution start already owns this call — do not race provisional args.
  if (ctx.state.toolMetaById.has(toolCall.id)) {
    return;
  }

  const provisional = buildProvisionalMutationArgs(toolCall.arguments);

  const now = Date.now();
  const state =
    ctx.state.provisionalToolStreamStateById ?? new Map<string, ProvisionalToolStreamState>();
  ctx.state.provisionalToolStreamStateById = state;
  const previous = state.get(toolCall.id);
  if (!shouldEmitProvisionalUpdate(previous, provisional, now)) {
    return;
  }

  const phase = previous?.started ? "update" : "start";
  state.set(toolCall.id, {
    lastEmittedAtMs: now,
    lastContentLength: provisional.content?.length ?? previous?.lastContentLength,
    started: true,
    lastPath: provisional.path ?? previous?.lastPath,
  });

  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase,
      name: toolName,
      toolCallId: toolCall.id,
      args: provisional,
    },
  });
  runBestEffortCallback({
    label: "provisional tool agent event",
    log: ctx.log,
    callback: () =>
      ctx.params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase,
          name: toolName,
          toolCallId: toolCall.id,
          args: provisional,
        },
      }),
  });
}
