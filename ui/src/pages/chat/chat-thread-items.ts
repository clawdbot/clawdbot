import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveToolUseId } from "../../../../src/chat/tool-content.js";
import { escapeRegExp } from "../../../../src/shared/regexp.js";
import type { ChatItem, ChatQueueItem, ToolCard } from "../../lib/chat/chat-types.ts";
import { extractTextCached, readTranscriptMediaEntries } from "../../lib/chat/message-extract.ts";
import {
  stripMessageDisplayMetadataText,
  normalizeRoleForGrouping,
} from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached, extractToolPreview } from "../../lib/chat/tool-cards.ts";
import { fnv1aUtf16 } from "../../lib/fnv1a.ts";
import { chatItemStartsUserTurn, safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

export function appendCanvasBlockToAssistantMessage(
  message: unknown,
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>,
  rawText: string | null,
) {
  const raw = message as Record<string, unknown>;
  const existingContent = Array.isArray(raw.content)
    ? [...raw.content]
    : typeof raw.content === "string"
      ? [{ type: "text", text: raw.content }]
      : typeof raw.text === "string"
        ? [{ type: "text", text: raw.text }]
        : [];
  const alreadyHasArtifact = existingContent.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const typed = block as {
      type?: unknown;
      preview?: { kind?: unknown; viewId?: unknown; url?: unknown };
    };
    return (
      typed.type === "canvas" &&
      typed.preview?.kind === "canvas" &&
      ((preview.viewId && typed.preview.viewId === preview.viewId) ||
        (preview.url && typed.preview.url === preview.url))
    );
  });
  if (alreadyHasArtifact) {
    return message;
  }
  return {
    ...raw,
    content: [
      ...existingContent,
      {
        type: "canvas",
        preview,
        ...(rawText ? { rawText } : {}),
      },
    ],
  };
}

export function messageMatchesSearchQuery(message: unknown, query: string): boolean {
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query);
  return (
    !normalizedQuery ||
    normalizeLowercaseStringOrEmpty(extractTextCached(message)).includes(normalizedQuery)
  );
}

export function turnHasMatchingAssistant(
  messages: unknown[],
  sourceIndex: number,
  searchQuery: string,
): boolean {
  for (let index = sourceIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    const normalized = safeNormalizeMessage(message);
    if (!normalized) {
      continue;
    }
    const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
    if (role === "user" || role === "system") {
      return false;
    }
    if (role === "assistant" && messageMatchesSearchQuery(message, searchQuery)) {
      return true;
    }
  }
  return false;
}

type ChatMessagePreview = {
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
  text: string | null;
  timestamp: number | null;
};

export function extractChatMessagePreview(toolMessage: unknown): ChatMessagePreview | null {
  if (!safeNormalizeMessage(toolMessage)) {
    return null;
  }
  const cards = extractToolCardsCached(toolMessage, "preview");
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === "canvas") {
      return {
        preview: card.preview,
        text: card.outputText ?? null,
        timestamp: rawMessageTimestamp(toolMessage),
      };
    }
  }
  const text = extractTextCached(toolMessage) ?? undefined;
  const toolRecord = toolMessage as Record<string, unknown>;
  const toolName =
    typeof toolRecord.toolName === "string"
      ? toolRecord.toolName
      : typeof toolRecord.tool_name === "string"
        ? toolRecord.tool_name
        : undefined;
  const preview = extractToolPreview(text, toolName);
  if (preview?.kind !== "canvas") {
    return null;
  }
  return { preview, text: text ?? null, timestamp: rawMessageTimestamp(toolMessage) };
}

export function canvasPreviewBaseIdentity(
  message: unknown,
  source: ChatMessagePreview,
): string | null {
  const toolCallId = resolveMessageToolUseId(asRecord(message) ?? {});
  const previewId = source.preview.viewId ?? source.preview.url;
  return toolCallId && previewId ? JSON.stringify([toolCallId, previewId]) : null;
}

export function createCanvasAssistantMessage(
  source: ChatMessagePreview,
  timestamp = source.timestamp,
): unknown {
  return appendCanvasBlockToAssistantMessage(
    {
      role: "assistant",
      content: [],
      ...(timestamp != null ? { timestamp } : {}),
    },
    source.preview,
    source.text,
  );
}

export function transcriptPositionTimestamp(
  messages: unknown[],
  sourceIndex: number,
): number | null {
  let previous: number | null = null;
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    previous = rawMessageTimestamp(messages[index]);
    if (previous != null) {
      break;
    }
  }
  let next: number | null = null;
  for (let index = sourceIndex + 1; index < messages.length; index += 1) {
    next = rawMessageTimestamp(messages[index]);
    if (next != null) {
      break;
    }
  }
  if (previous != null && next != null) {
    return previous < next ? Math.min(previous + 1, next) : next;
  }
  if (previous != null) {
    return previous + 1;
  }
  return next;
}

export function findNearestAssistantMessageIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
  minimumIndex = 0,
  maximumIndex = items.length,
): number | null {
  let currentTurnStart = minimumIndex;
  let currentTurnEnd = maximumIndex;
  for (let index = minimumIndex; index < maximumIndex; index += 1) {
    const item = items[index];
    if (!item || !chatItemStartsUserTurn(item)) {
      continue;
    }
    const boundaryTimestamp =
      item.kind === "notice"
        ? item.timestamp
        : item.kind === "message"
          ? (safeNormalizeMessage(item.message)?.timestamp ?? null)
          : null;
    if (toolTimestamp != null && boundaryTimestamp != null && boundaryTimestamp > toolTimestamp) {
      currentTurnEnd = index;
      break;
    }
    currentTurnStart = index + 1;
  }
  const assistantEntries = items
    .map((item, index) => {
      if (index < currentTurnStart || index >= currentTurnEnd || item.kind !== "message") {
        return null;
      }
      const message = asRecord(item.message);
      const role = typeof message?.role === "string" ? message.role.toLowerCase() : "";
      if (role !== "assistant") {
        return null;
      }
      return {
        index,
        timestamp: safeNormalizeMessage(item.message)?.timestamp ?? null,
      };
    })
    .filter(Boolean) as Array<{ index: number; timestamp: number | null }>;
  if (assistantEntries.length === 0) {
    return null;
  }
  if (toolTimestamp == null) {
    return assistantEntries[assistantEntries.length - 1]?.index ?? null;
  }
  let previous: { index: number; timestamp: number } | null = null;
  let next: { index: number; timestamp: number } | null = null;
  for (const entry of assistantEntries) {
    if (entry.timestamp == null) {
      continue;
    }
    if (entry.timestamp <= toolTimestamp) {
      previous = { index: entry.index, timestamp: entry.timestamp };
      continue;
    }
    next = { index: entry.index, timestamp: entry.timestamp };
    break;
  }
  if (previous && next) {
    const previousDelta = toolTimestamp - previous.timestamp;
    const nextDelta = next.timestamp - toolTimestamp;
    return nextDelta < previousDelta ? next.index : previous.index;
  }
  if (previous) {
    return previous.index;
  }
  if (next) {
    return next.index;
  }
  return assistantEntries[assistantEntries.length - 1]?.index ?? null;
}

export function findCanvasInsertionIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
  minimumIndex = 0,
  maximumIndex = items.length,
): number {
  if (toolTimestamp == null) {
    return maximumIndex;
  }
  for (let index = minimumIndex; index < maximumIndex; index += 1) {
    const item = items[index];
    if (item?.kind !== "message") {
      continue;
    }
    const normalized = safeNormalizeMessage(item.message);
    if (
      normalized &&
      normalizeRoleForGrouping(normalized.role).toLowerCase() === "user" &&
      normalized.timestamp != null &&
      normalized.timestamp > toolTimestamp
    ) {
      return index;
    }
  }
  return maximumIndex;
}

function resolveMessageToolUseId(message: Record<string, unknown>): string | undefined {
  for (const field of ["tool_call_id", "toolCallId", "tool_use_id", "toolUseId"] as const) {
    const value = message[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function resolveToolBlockId(
  block: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  return resolveToolUseId(block) ?? resolveMessageToolUseId(message);
}

export function isPendingSendMessage(message: unknown): boolean {
  return asRecord(asRecord(message)?.["__openclaw"])?.kind === "pending-send";
}

export function readPendingSendFailure(message: unknown): {
  error?: string;
  id: string;
  state: "failed" | "unconfirmed";
} | null {
  const metadata = asRecord(asRecord(message)?.["__openclaw"]);
  const state = metadata?.state;
  const id = metadata?.id;
  if (
    metadata?.kind !== "pending-send" ||
    (state !== "failed" && state !== "unconfirmed") ||
    typeof id !== "string"
  ) {
    return null;
  }
  return {
    id,
    state,
    ...(typeof metadata.error === "string" ? { error: metadata.error } : {}),
  };
}

function readChatThreadMessageIdentity(message: unknown) {
  const record = asRecord(message);
  const surfaceId =
    typeof record?.messageId === "string" && record.messageId.trim()
      ? record.messageId
      : record?.id;
  return readSessionMessageIdentity(message, { messageId: surfaceId });
}

/** Every projection of one composer submit (pending queue row, locally
 * materialized turn, authoritative history) shares this identity so the
 * rendered bubble keeps one Lit key and never remounts mid-handoff. */
export function userTurnSendIdentity(message: unknown): string | null {
  const identity = readChatThreadMessageIdentity(message);
  return identity?.role === "user" && identity.runId ? `send:${identity.runId}` : null;
}

export function persistedMessageEntryId(message: unknown): string | null {
  return isPendingSendMessage(message)
    ? null
    : (readChatThreadMessageIdentity(message)?.id ?? null);
}

function transcriptMessageSourceKey(message: unknown): string | null {
  // Send identity outranks transcript ids: the same submit is re-projected with
  // different id/seq metadata across the pending -> history handoff, and a key
  // change there remounts the bubble (visible flicker).
  const sendIdentity = userTurnSendIdentity(message);
  if (sendIdentity) {
    return sendIdentity;
  }
  const identity = readChatThreadMessageIdentity(message);
  if (identity?.isImported) {
    if (identity.externalSource) {
      return `import:${identity.externalSource}`;
    }
    return identity.sequence === null ? null : `import-seq:${identity.sequence}`;
  }
  if (identity?.id) {
    return `id:${identity.id}`;
  }
  return identity?.sequence == null ? null : `seq:${identity.sequence}`;
}

const messageProjectionDigests = new WeakMap<object, string>();

function messageProjectionDigest(message: unknown): string {
  if (message && typeof message === "object") {
    const cached = messageProjectionDigests.get(message);
    if (cached) {
      return cached;
    }
  }
  const record = asRecord(message);
  const source = [
    typeof record?.role === "string" ? record.role : "",
    typeof record?.toolCallId === "string" ? record.toolCallId : "",
    record ? extractTextCached(message) : "",
  ].join("\u0000");
  const digest = `p${fnv1aUtf16(source).toString(36)}${source.length.toString(36)}`;
  if (message && typeof message === "object") {
    messageProjectionDigests.set(message, digest);
  }
  return digest;
}

export function buildMessageKeys(messages: unknown[], indexOffset = 0): string[] {
  const sourceKeys = messages.map(transcriptMessageSourceKey);
  const sourceCounts = new Map<string, number>();
  for (const sourceKey of sourceKeys) {
    if (sourceKey) {
      sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1);
    }
  }
  const projectionOccurrences = new Map<string, number>();
  return messages.map((message, index) => {
    const sourceKey = sourceKeys[index];
    const needsProjectionIdentity = sourceKey == null || (sourceCounts.get(sourceKey) ?? 0) > 1;
    const projectionKey = needsProjectionIdentity
      ? `${sourceKey ?? "legacy"}:projection:${messageProjectionDigest(message)}`
      : (sourceKey ?? "legacy");
    const occurrence = projectionOccurrences.get(projectionKey) ?? 0;
    projectionOccurrences.set(projectionKey, occurrence + 1);
    return messageKey(message, index + indexOffset, `${projectionKey}:${occurrence}`);
  });
}

function collapseDuplicateSourceKey(message: unknown): string | null {
  if (isPendingSendMessage(message)) {
    return null;
  }
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (role !== "assistant" && role !== "user") {
    return null;
  }
  const identity = readChatThreadMessageIdentity(message);
  if (!identity?.isImported) {
    return identity?.id ? `${role}:${identity.id}` : null;
  }
  if (identity.externalSource) {
    return `${role}:import:${identity.externalSource}`;
  }
  return identity.sequence === null ? null : `${role}:import-seq:${identity.sequence}`;
}

function prefersNativeChatSurface(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  return (role === "user" || role === "assistant") && !(normalized.senderLabel ?? "").trim();
}

function stripSenderLabelPrefix(text: string, senderLabel: string): string {
  const label = senderLabel.trim();
  if (!label) {
    return text;
  }
  return text.replace(new RegExp(`^${escapeRegExp(label)}(?::|：|-|—)?[ \\t]+`), "");
}

function textOnlyMessageParts(message: unknown) {
  const normalized = safeNormalizeMessage(message);
  if (!normalized || normalized.content.length === 0) {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    textParts.push(block.text);
  }
  return {
    role: normalizeRoleForGrouping(normalized.role).toLowerCase(),
    senderLabel: (normalized.senderLabel ?? "").trim(),
    text: textParts.join("\n"),
  };
}

function sourceDuplicateDisplayParts(message: unknown) {
  const parts = textOnlyMessageParts(message);
  return parts?.role === "assistant" && parts.text.trim() ? parts : null;
}

function isSameSourceRelayNativeDuplicate(previousMessage: unknown, nextMessage: unknown): boolean {
  const previous = sourceDuplicateDisplayParts(previousMessage);
  const next = sourceDuplicateDisplayParts(nextMessage);
  if (!previous || !next || previous.role !== next.role) {
    return false;
  }
  if (Boolean(previous.senderLabel) === Boolean(next.senderLabel)) {
    return false;
  }
  const labeled = previous.senderLabel ? previous : next;
  const native = previous.senderLabel ? next : previous;
  return (
    labeled.text === native.text ||
    stripSenderLabelPrefix(labeled.text, labeled.senderLabel) === native.text
  );
}

function collapseDuplicateDisplaySignature(message: unknown): string | null {
  if (isPendingSendMessage(message)) {
    return null;
  }
  const parts = textOnlyMessageParts(message);
  if (!parts || !parts.role || parts.role === "tool") {
    return null;
  }
  const { role } = parts;
  const text = parts.text.trim().replace(/\s+/g, " ");
  if (!text) {
    return null;
  }
  const senderLabel = role === "user" || role === "assistant" ? parts.senderLabel : "";
  return `${role}:${senderLabel}:${text}`;
}

export function collapseSequentialDuplicateMessages(items: ChatItem[]): ChatItem[] {
  const collapsed: ChatItem[] = [];
  let previousSignature: string | null = null;
  let previousSourceKey: string | null = null;
  let previousSourceIsUnprovenImport = false;

  for (const item of items) {
    if (item.kind !== "message") {
      collapsed.push(item);
      previousSignature = null;
      previousSourceKey = null;
      previousSourceIsUnprovenImport = false;
      continue;
    }
    const signature = collapseDuplicateDisplaySignature(item.message);
    const sourceKey = collapseDuplicateSourceKey(item.message);
    const identity = readChatThreadMessageIdentity(item.message);
    const sourceIsUnprovenImport =
      sourceKey === null &&
      identity?.isImported === true &&
      identity.externalSource === null &&
      identity.sequence === null;
    const previous = collapsed[collapsed.length - 1];
    if (
      sourceKey &&
      previousSourceKey === sourceKey &&
      previous?.kind === "message" &&
      isSameSourceRelayNativeDuplicate(previous.message, item.message)
    ) {
      if (!prefersNativeChatSurface(previous.message) && prefersNativeChatSurface(item.message)) {
        collapsed[collapsed.length - 1] = item;
        previousSignature = signature;
      }
      continue;
    }
    if (
      signature &&
      previousSignature === signature &&
      previous?.kind === "message" &&
      !sourceIsUnprovenImport &&
      !previousSourceIsUnprovenImport &&
      !(sourceKey && previousSourceKey && sourceKey !== previousSourceKey)
    ) {
      previous.duplicateCount = (previous.duplicateCount ?? 1) + 1;
      continue;
    }
    collapsed.push(item);
    previousSignature = signature;
    previousSourceKey = sourceKey;
    previousSourceIsUnprovenImport = sourceIsUnprovenImport;
  }

  return collapsed;
}
export function hasRenderableNormalizedMessage(
  message: unknown,
  normalized = safeNormalizeMessage(message),
): boolean {
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role);
  const label = role === "assistant" && normalized.senderLabel?.trim();
  const media = role === "user" && readTranscriptMediaEntries(message).length;
  return Boolean(
    role === "tool" || normalized.content.length || normalized.replyTarget || label || media,
  );
}

export function sanitizeStreamText(text: string): string {
  const stripped = stripMessageDisplayMetadataText(text);
  return stripped.trim().length > 0 ? stripped : "";
}

export function queuedSendThreadMessage(item: ChatQueueItem): Record<string, unknown> | null {
  const runId = item.sendRunId ?? item.pendingRunId;
  return buildLocalUserMessage({
    text: item.text,
    attachments: item.attachments,
    createdAt: item.createdAt,
    ...(runId ? { runId } : {}),
    replyToId: item.replyToId,
    sender: item.sender,
    pending: {
      id: item.id,
      state: item.sendState,
      error: item.sendError,
    },
  });
}

export function rawMessageTimestamp(message: unknown): number | null {
  return asFiniteNumber(asRecord(message)?.timestamp) ?? null;
}

function chatItemTimestamp(item: ChatItem): number | null {
  switch (item.kind) {
    case "message":
      return rawMessageTimestamp(item.message);
    case "divider":
    case "notice":
      return item.timestamp;
    case "stream":
      return item.startedAt;
    case "question":
      return item.startedAt;
    case "reading-indicator":
      return null;
  }
  return null;
}

export function timestampAfterVisibleItems(items: ChatItem[], desiredTimestamp: number): number {
  const latestTimestamp = items.reduce<number | null>((latest, item) => {
    const timestamp = chatItemTimestamp(item);
    if (timestamp == null) {
      return latest;
    }
    return latest == null || timestamp > latest ? timestamp : latest;
  }, null);
  return latestTimestamp != null && desiredTimestamp <= latestTimestamp
    ? latestTimestamp + 1
    : desiredTimestamp;
}

// Insert live tool/stream items into an already-ordered list of stable chat rows
// (history, queued sends, canvas previews, etc.) by visible timestamp. Stable
// rows keep their relative order; only tool cards and stream segments are
// repositioned. This avoids reordering optimistic user bubbles or final
// assistant replies when their timestamps come from different clocks (#112943).
export type TurnInsertionBounds = { afterKey?: string; beforeKey?: string };

export function insertionIndexesForBounds(
  items: ChatItem[],
  bounds: TurnInsertionBounds | undefined,
): { minimum: number; maximum: number } {
  const afterIndex = bounds?.afterKey
    ? items.findIndex((item) => item.key === bounds.afterKey)
    : -1;
  const beforeIndex = bounds?.beforeKey
    ? items.findIndex((item) => item.key === bounds.beforeKey)
    : -1;
  return {
    minimum: afterIndex + 1,
    maximum: beforeIndex >= 0 ? beforeIndex : items.length,
  };
}

export function insertChatItemsByTimestamp(
  items: ChatItem[],
  inserts: ChatItem[],
  insertionBoundsByKey: ReadonlyMap<string, TurnInsertionBounds>,
  toolStreamPredecessors: ReadonlyMap<string, string>,
): void {
  const timestampsByKey = new Map<string, number>();
  for (const item of inserts) {
    const timestamp = chatItemTimestamp(item);
    if (timestamp != null) {
      timestampsByKey.set(item.key, timestamp);
    }
  }
  // Sort inserts among themselves by timestamp, preserving the original index
  // order for ties and honoring predecessor relationships so a stream segment
  // stays before the tool card it introduced.
  const sortedInserts = inserts
    .map((item, index) => {
      const rawTimestamp = chatItemTimestamp(item);
      const predecessorKey = toolStreamPredecessors.get(item.key);
      const predecessorTimestamp = predecessorKey ? timestampsByKey.get(predecessorKey) : null;
      return {
        item,
        index,
        predecessorKey,
        effectiveTimestamp:
          rawTimestamp != null && predecessorTimestamp != null
            ? Math.max(rawTimestamp, predecessorTimestamp)
            : rawTimestamp,
      };
    })
    .toSorted((a, b) => {
      if (a.effectiveTimestamp == null && b.effectiveTimestamp == null) {
        return a.index - b.index;
      }
      if (a.effectiveTimestamp == null) {
        return 1;
      }
      if (b.effectiveTimestamp == null) {
        return -1;
      }
      if (a.effectiveTimestamp !== b.effectiveTimestamp) {
        return a.effectiveTimestamp - b.effectiveTimestamp;
      }
      if (a.predecessorKey === b.item.key) {
        return 1;
      }
      if (b.predecessorKey === a.item.key) {
        return -1;
      }
      return a.index - b.index;
    });

  for (const { item, effectiveTimestamp } of sortedInserts) {
    const { minimum, maximum } = insertionIndexesForBounds(
      items,
      insertionBoundsByKey.get(item.key),
    );
    if (effectiveTimestamp == null) {
      items.splice(maximum, 0, item);
      continue;
    }
    const insertionIndex = items.findIndex((existing, index) => {
      if (index < minimum || index >= maximum) {
        return false;
      }
      const existingTimestamp = chatItemTimestamp(existing);
      // Timestamped inserts render before stable items that lack a timestamp.
      if (existingTimestamp == null) {
        return true;
      }
      return existingTimestamp > effectiveTimestamp;
    });

    if (insertionIndex === -1) {
      items.splice(maximum, 0, item);
    } else {
      items.splice(insertionIndex, 0, item);
    }
  }
}

export function messageKey(message: unknown, index: number, transcriptKey?: string): string {
  const m = asRecord(message) ?? {};
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  const role = typeof m.role === "string" ? m.role : "unknown";
  const id = typeof m.id === "string" && m.id ? m.id : null;
  const messageId = typeof m.messageId === "string" && m.messageId ? m.messageId : null;
  const identity = id ?? messageId;
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  if (toolCallId) {
    const suffix =
      transcriptKey ?? identity ?? (timestamp == null ? index : `${timestamp}:${index}`);
    return `tool:${role}:${toolCallId}:${suffix}`;
  }
  if (transcriptKey) {
    return `msg:${transcriptKey}`;
  }
  if (identity) {
    return `msg:${identity}`;
  }
  return timestamp == null ? `msg:${role}:${index}` : `msg:${role}:${timestamp}:${index}`;
}
