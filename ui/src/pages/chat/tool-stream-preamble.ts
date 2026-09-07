import { readAssistantStreamSegmentIdentity } from "@openclaw/gateway-client/browser";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import { accumulatedStreamText, trimAccumulatedStreamPrefix } from "../../lib/chat/chat-types.ts";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { AgentEventPayload, ToolStreamHost } from "./tool-stream-contract.ts";
import { resolveAcceptedSession } from "./tool-stream-status.ts";

function readPreambleProgressEvent(
  payload: AgentEventPayload,
): { text: string; itemId?: string } | null {
  if (payload.stream !== "item") {
    return null;
  }
  const data = payload.data ?? {};
  if (data.kind !== "preamble") {
    return null;
  }
  const rawItemId =
    typeof data.itemId === "string" && data.itemId.trim()
      ? data.itemId
      : typeof data.id === "string" && data.id.trim()
        ? data.id
        : null;
  const itemId = rawItemId?.trim();
  const progressText = normalizePreambleProgressText(data.progressText);
  if (!progressText && !itemId) {
    return null;
  }
  return {
    text: progressText,
    ...(itemId ? { itemId } : {}),
  };
}

function normalizePreambleProgressText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const stripped = stripInlineDirectiveTagsForDelivery(value).text.trim();
  const normalized = stripped.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "").trim();
  return /^NO_REPLY$/iu.test(normalized) ? "" : stripped;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Transports that resolve commentary only at the tool boundary (openai-completions,
 * anthropic) first stream the same text unphased through the chat delta lane, where
 * it carries a run-scoped stream id instead of the item id the phase tagger later
 * assigns. Once the keyed item owns that text, retire it from the cumulative chat
 * stream as a persisted prefix so the item and the stream do not both render it.
 */
function retireStreamTextOwnedByCommentary(
  host: ToolStreamHost,
  payload: AgentEventPayload,
  progressText: string,
): void {
  if (host.chatRunId !== payload.runId || typeof host.chatStream !== "string") {
    return;
  }
  const segments = host.chatStreamSegments ?? [];
  const tail = trimAccumulatedStreamPrefix(host.chatStream, accumulatedStreamText(segments));
  if (
    !tail.trim() ||
    collapseWhitespace(normalizePreambleProgressText(tail)) !== collapseWhitespace(progressText)
  ) {
    return;
  }
  const last = segments.at(-1);
  const extendsPersisted =
    last?.persisted === true &&
    last.runId === payload.runId &&
    !last.boundaryRunId &&
    !last.toolCallId;
  host.chatStreamSegments = [
    ...(extendsPersisted ? segments.slice(0, -1) : segments),
    {
      ...(extendsPersisted ? last : {}),
      text: host.chatStream,
      ts: host.chatStreamStartedAt ?? payload.ts,
      runId: payload.runId,
      persisted: true,
    },
  ];
}

export function handlePreambleProgress(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  const progress = readPreambleProgressEvent(payload);
  if (!progress) {
    return false;
  }
  // Preambles belong to the visible run; a sibling run must never replace,
  // clear, or persist its commentary into this transcript.
  if (!resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true }).accepted) {
    return true;
  }
  if (progress.text) {
    reconcileChatRunStartup(host, { state: "activity", runId: payload.runId, seq: payload.seq });
  }
  const persisted =
    progress.itemId &&
    host.chatMessages?.some((message) => {
      const identity = readAssistantStreamSegmentIdentity(message);
      return identity?.itemId === progress.itemId && identity?.runId === payload.runId;
    });
  if (persisted) {
    // A history snapshot or delayed live event can follow the durable row.
    // Its exact run/item owner already renders the commentary.
    host.chatStreamSegments = host.chatStreamSegments.filter(
      (segment) => segment.itemId !== progress.itemId || segment.runId !== payload.runId,
    );
    return true;
  }
  if (progress.itemId && !progress.text.trim()) {
    host.chatStreamSegments = host.chatStreamSegments.filter(
      (segment) => segment.itemId !== progress.itemId,
    );
    return true;
  }
  if (progress.itemId) {
    retireStreamTextOwnedByCommentary(host, payload, progress.text);
  }
  const existingIndex = progress.itemId
    ? host.chatStreamSegments.findIndex((segment) => segment.itemId === progress.itemId)
    : -1;
  if (existingIndex >= 0) {
    const existing = host.chatStreamSegments[existingIndex];
    if (!existing) {
      return true;
    }
    host.chatStreamSegments = host.chatStreamSegments.map((segment, index) =>
      index === existingIndex ? { ...segment, text: progress.text, runId: payload.runId } : segment,
    );
    return true;
  }
  const last = host.chatStreamSegments[host.chatStreamSegments.length - 1];
  if (!progress.itemId && last && !last.toolCallId && last.text === progress.text) {
    return true;
  }
  host.chatStreamSegments = [
    ...host.chatStreamSegments,
    {
      text: progress.text,
      ts: payload.ts,
      runId: payload.runId,
      ...(progress.itemId ? { itemId: progress.itemId } : {}),
    },
  ];
  return true;
}
