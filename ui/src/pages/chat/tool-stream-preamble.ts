import { readAssistantStreamSegmentIdentity } from "@openclaw/gateway-client/browser";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import { retireCommentaryStream } from "./stream-segment-pruning.ts";
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
  const existingIndex = progress.itemId
    ? host.chatStreamSegments.findIndex(
        (segment) => segment.itemId === progress.itemId && segment.runId === payload.runId,
      )
    : -1;
  const existing = host.chatStreamSegments[existingIndex];
  const handoff =
    progress.itemId && progress.text && (!existing || existing.pendingStreamText)
      ? retireCommentaryStream(host, {
          runId: payload.runId,
          itemId: progress.itemId,
          text: progress.text,
          timestamp: payload.ts,
          pendingStreamText: existing?.pendingStreamText,
        })
      : null;
  progress.text = handoff?.text ?? progress.text;
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
      (segment) => segment.itemId !== progress.itemId || segment.runId !== payload.runId,
    );
    return true;
  }
  if (existing) {
    host.chatStreamSegments = host.chatStreamSegments.map((segment) =>
      segment === existing
        ? {
            ...segment,
            pendingStreamText: handoff?.pendingStreamText,
            text:
              segment.text.replace(/\s+/gu, " ").trim() === progress.text
                ? segment.text
                : progress.text,
          }
        : segment,
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
      ...(handoff?.pendingStreamText ? { pendingStreamText: handoff.pendingStreamText } : {}),
    },
  ];
  return true;
}
