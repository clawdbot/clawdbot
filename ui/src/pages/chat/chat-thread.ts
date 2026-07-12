// Control UI chat module owns Chat thread item derivation and thread-local caches.
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import type {
  ChatItem,
  MessageGroup,
  NormalizedMessage,
  ToolCard,
} from "../../lib/chat/chat-types.ts";
import {
  CHAT_HISTORY_RENDER_CHAR_BUDGET,
  CHAT_HISTORY_RENDER_LIMIT,
} from "../../lib/chat/chat-types.ts";
import {
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  trimAccumulatedStreamPrefix,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../../lib/chat/heartbeat-display.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeMessage,
  stripMessageDisplayMetadataText,
} from "../../lib/chat/message-normalizer.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached, extractToolPreview } from "../../lib/chat/tool-cards.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import { getOrCreateSessionCacheValue } from "./session-cache.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

export type BuildChatItemsProps = {
  sessionKey: string;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  queue?: ChatQueueItem[];
  showToolCalls: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
  historyRenderLimit?: number;
};

type CachedChatItems = {
  input: BuildChatItemsProps | null;
  items: ReturnType<typeof buildChatItems>;
};

type RenderChatItem = ReturnType<typeof buildChatItems>[number];
type StreamRunRenderItem = {
  kind: "stream-run";
  key: string;
  parts: Array<Extract<ChatItem, { kind: "stream" } | { kind: "reading-indicator" }>>;
};

const chatItemsBySession = new Map<string, CachedChatItems>();
const expandedToolCardsBySession = new Map<string, Map<string, boolean>>();
const initializedToolCardsBySession = new Map<string, Set<string>>();
const lastAutoExpandPrefBySession = new Map<string, boolean>();

export function resetChatThreadState(): void {
  chatItemsBySession.clear();
  expandedToolCardsBySession.clear();
  initializedToolCardsBySession.clear();
  lastAutoExpandPrefBySession.clear();
}

function appendCanvasBlockToAssistantMessage(
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeNormalizeMessage(message: unknown): NormalizedMessage | null {
  if (!asRecord(message)) {
    return null;
  }
  try {
    return normalizeMessage(message);
  } catch {
    return null;
  }
}

function messageMatchesSearchQuery(message: unknown, query: string): boolean {
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query);
  if (!normalizedQuery) {
    return true;
  }
  const text = normalizeLowercaseStringOrEmpty(extractTextCached(message));
  return text.includes(normalizedQuery);
}

function extractChatMessagePreview(toolMessage: unknown): {
  preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
  text: string | null;
  timestamp: number | null;
} | null {
  const normalized = safeNormalizeMessage(toolMessage);
  if (!normalized) {
    return null;
  }
  const cards = extractToolCardsCached(toolMessage, "preview");
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card?.preview?.kind === "canvas") {
      return {
        preview: card.preview,
        text: card.outputText ?? null,
        timestamp: normalized.timestamp ?? null,
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
  return { preview, text: text ?? null, timestamp: normalized.timestamp ?? null };
}

function findNearestAssistantMessageIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
): number | null {
  const assistantEntries = items
    .map((item, index) => {
      if (item.kind !== "message") {
        return null;
      }
      const message = item.message as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
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

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel =
      role.toLowerCase() === "user" || role.toLowerCase() === "assistant"
        ? (normalized.senderLabel ?? null)
        : null;
    const timestamp = normalized.timestamp || Date.now();
    const shouldSplitBySender = role.toLowerCase() === "user" || role.toLowerCase() === "assistant";

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (shouldSplitBySender && currentGroup.senderLabel !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        messages: [{ message: item.message, key: item.key, duplicateCount: item.duplicateCount }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({
        message: item.message,
        key: item.key,
        duplicateCount: item.duplicateCount,
      });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function mergeToolCallResultPair(callItem: ChatItem, resultItem: ChatItem): ChatItem | null {
  if (callItem.kind !== "message" || resultItem.kind !== "message") {
    return null;
  }
  const callMessage = asRecord(callItem.message);
  const resultMessage = asRecord(resultItem.message);
  if (!callMessage || !resultMessage) {
    return null;
  }
  const callRole = typeof callMessage.role === "string" ? callMessage.role.toLowerCase() : "";
  const normalizedResult = safeNormalizeMessage(resultItem.message);
  const resultRole = normalizedResult ? normalizeRoleForGrouping(normalizedResult.role) : "unknown";
  if (callRole !== "assistant" || resultRole !== "tool" || !Array.isArray(callMessage.content)) {
    return null;
  }
  const hasToolCallBlock = callMessage.content.some((block) =>
    isToolCallContentType(asRecord(block)?.type),
  );
  if (!hasToolCallBlock) {
    return null;
  }

  const callCards = extractToolCardsCached(callItem.message, `${callItem.key}:activity-call`);
  const resultCards = extractToolCardsCached(
    resultItem.message,
    `${resultItem.key}:activity-result`,
  );
  if (callCards.length === 0 || resultCards.length === 0) {
    return null;
  }
  const rawResultContent = Array.isArray(resultMessage.content) ? resultMessage.content : [];
  if (rawResultContent.some((block) => isToolCallContentType(asRecord(block)?.type))) {
    return null;
  }
  const resultOnlyContent = rawResultContent.filter(
    (block) => !isToolCallContentType(asRecord(block)?.type),
  );
  const hasToolResultBlock = resultOnlyContent.some((block) =>
    isToolResultContentType(asRecord(block)?.type),
  );
  const hasToolResult =
    hasToolResultBlock ||
    resultCards.some((card) => card.outputText !== undefined || card.isError !== undefined);
  if (!hasToolResult) {
    return null;
  }

  const unresolvedCallIds = unresolvedToolCallIds(callItem);
  const matchedResults = new Map<string, { resultCard: ToolCard; resultName: string }>();
  for (const resultCard of resultCards) {
    const callId = resultCard.callId;
    if (!callId || !unresolvedCallIds.has(callId) || matchedResults.has(callId)) {
      return null;
    }
    const callCard = callCards.find((card) => card.callId === callId);
    if (!callCard) {
      return null;
    }
    const resultName = resultCard.name === "tool" ? callCard.name : resultCard.name;
    if (
      normalizeLowercaseStringOrEmpty(callCard.name) !== normalizeLowercaseStringOrEmpty(resultName)
    ) {
      return null;
    }
    matchedResults.set(callId, { resultCard, resultName });
  }

  const preservedResultContent = resultOnlyContent.filter(
    (block) => asRecord(block)?.type !== "text",
  );
  // Raw transcript result blocks usually carry the call id and tool name on the
  // message, not the block. Stamp both onto the merged blocks (plus message-level
  // details) so card extraction pairs them with the call instead of rendering a
  // second bare "Tool" card.
  const resultContent = hasToolResultBlock
    ? resultOnlyContent.map((block) => {
        const record = asRecord(block);
        if (!record || !isToolResultContentType(record.type)) {
          return block;
        }
        const callId = resolveToolBlockId(record, resultMessage);
        const matched = callId ? matchedResults.get(callId) : undefined;
        if (!matched) {
          return block;
        }
        const stamped: Record<string, unknown> = Object.assign({}, record);
        stamped.id = callId;
        stamped.name =
          typeof record.name === "string" && record.name.trim() ? record.name : matched.resultName;
        if (record.details === undefined && resultMessage.details !== undefined) {
          stamped.details = resultMessage.details;
        }
        if (
          record.isError === undefined &&
          record.is_error === undefined &&
          matched.resultCard.isError !== undefined
        ) {
          stamped.isError = matched.resultCard.isError;
        }
        return stamped;
      })
    : (() => {
        const [matched] = matchedResults.values();
        if (!matched) {
          return preservedResultContent;
        }
        return [
          {
            type: "tool_result",
            id: matched.resultCard.callId,
            name: matched.resultName,
            text: matched.resultCard.outputText ?? "",
            ...(matched.resultCard.details !== undefined
              ? { details: matched.resultCard.details }
              : {}),
            ...(matched.resultCard.isError !== undefined
              ? { isError: matched.resultCard.isError }
              : {}),
          },
          ...preservedResultContent,
        ];
      })();
  return {
    ...callItem,
    message: {
      ...callMessage,
      content: [...callMessage.content, ...resultContent],
    },
  };
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

function resolveToolBlockId(
  block: Record<string, unknown>,
  message: Record<string, unknown>,
): string | undefined {
  return resolveToolUseId(block) ?? resolveMessageToolUseId(message);
}

function unresolvedToolCallIds(item: ChatItem): Set<string> {
  const unresolved = new Set<string>();
  if (item.kind !== "message") {
    return unresolved;
  }
  const message = asRecord(item.message);
  if (
    !message ||
    typeof message.role !== "string" ||
    message.role.toLowerCase() !== "assistant" ||
    !Array.isArray(message.content)
  ) {
    return unresolved;
  }
  for (const block of message.content) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    const callId = resolveToolBlockId(record, message);
    if (!callId) {
      continue;
    }
    if (isToolCallContentType(record.type)) {
      unresolved.add(callId);
    } else if (isToolResultContentType(record.type)) {
      unresolved.delete(callId);
    }
  }
  return unresolved;
}

function isToolTimelineItem(item: ChatItem): boolean {
  if (item.kind !== "message") {
    return false;
  }
  const normalized = safeNormalizeMessage(item.message);
  return normalized ? normalizeRoleForGrouping(normalized.role) === "tool" : false;
}

function splitBundledToolResultItems(item: ChatItem): ChatItem[] {
  if (item.kind !== "message") {
    return [item];
  }
  const message = asRecord(item.message);
  if (!message || !Array.isArray(message.content) || message.content.length < 2) {
    return [item];
  }
  const blocksByCallId = new Map<string, unknown[]>();
  for (const block of message.content) {
    const record = asRecord(block);
    if (!record || !isToolResultContentType(record.type)) {
      return [item];
    }
    const callId = resolveToolBlockId(record, message);
    if (!callId) {
      return [item];
    }
    const blocks = blocksByCallId.get(callId) ?? [];
    blocks.push(block);
    blocksByCallId.set(callId, blocks);
  }
  if (blocksByCallId.size < 2) {
    return [item];
  }
  return Array.from(blocksByCallId.values(), (content, index) => ({
    ...item,
    key: `${item.key}:result:${index}`,
    message: { ...message, content },
  }));
}

function resolveToolResultCallId(item: ChatItem): string | undefined {
  if (item.kind !== "message") {
    return undefined;
  }
  const message = asRecord(item.message);
  if (!message) {
    return undefined;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  if (content.some((block) => isToolCallContentType(asRecord(block)?.type))) {
    return undefined;
  }
  const resultIds = new Set<string>();
  for (const block of content) {
    const record = asRecord(block);
    if (record && isToolResultContentType(record.type)) {
      const callId = resolveToolBlockId(record, message);
      if (callId) {
        resultIds.add(callId);
      }
    }
  }
  if (resultIds.size > 1) {
    return undefined;
  }
  return resultIds.values().next().value ?? resolveMessageToolUseId(message);
}

function refreshOpenCallIds(
  openCallIndexes: Map<string, number>,
  coalesced: ChatItem[],
  callIndex: number,
) {
  for (const [callId, index] of openCallIndexes) {
    if (index === callIndex) {
      openCallIndexes.delete(callId);
    }
  }
  for (const callId of unresolvedToolCallIds(coalesced[callIndex])) {
    openCallIndexes.set(callId, callIndex);
  }
}

function coalesceToolActivityMessages(items: ChatItem[]): ChatItem[] {
  const coalesced: ChatItem[] = [];
  // Parallel calls can outnumber any fixed lookback window, so each unresolved
  // call id owns its current transcript item until a non-tool boundary.
  const openCallIndexes = new Map<string, number>();
  for (const item of items) {
    const resultItems = splitBundledToolResultItems(item);
    const unmatchedResultItems: ChatItem[] = [];
    let mergedResult = false;
    for (const resultItem of resultItems) {
      const callId = resolveToolResultCallId(resultItem);
      const callIndex = callId ? openCallIndexes.get(callId) : undefined;
      const merged =
        callIndex === undefined ? null : mergeToolCallResultPair(coalesced[callIndex], resultItem);
      if (!merged || callIndex === undefined) {
        unmatchedResultItems.push(resultItem);
        continue;
      }
      coalesced[callIndex] = merged;
      refreshOpenCallIds(openCallIndexes, coalesced, callIndex);
      mergedResult = true;
    }
    if (mergedResult) {
      for (const unmatched of unmatchedResultItems) {
        coalesced.push(unmatched);
      }
      continue;
    }

    const unresolvedCallIds = unresolvedToolCallIds(item);
    if (unresolvedCallIds.size === 1) {
      const callId = unresolvedCallIds.values().next().value;
      const previousIndex = callId ? openCallIndexes.get(callId) : undefined;
      if (
        previousIndex !== undefined &&
        unresolvedToolCallIds(coalesced[previousIndex]).size === 1
      ) {
        coalesced[previousIndex] = item;
        refreshOpenCallIds(openCallIndexes, coalesced, previousIndex);
        continue;
      }
    }

    coalesced.push(item);
    if (unresolvedCallIds.size > 0) {
      const callIndex = coalesced.length - 1;
      for (const callId of unresolvedCallIds) {
        openCallIndexes.set(callId, callIndex);
      }
      continue;
    }
    if (isToolTimelineItem(item)) {
      // Orphan results keep the window open for later siblings.
      continue;
    }
    // Any other content (user text, assistant reply, dividers) closes the run.
    openCallIndexes.clear();
  }
  return coalesced;
}

function assistantGroupHasReplyText(group: MessageGroup): boolean {
  return group.messages.some(({ message }) => Boolean(extractTextCached(message)?.trim()));
}

function assistantGroupIsForwardedBoundary(group: MessageGroup): boolean {
  return group.messages.some(({ message }) => {
    const provenance = asRecord(asRecord(message)?.provenance);
    return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send";
  });
}

function annotateToolTurnOutcome(
  items: Array<ChatItem | MessageGroup>,
): Array<ChatItem | MessageGroup> {
  let sawAssistantReply = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== "group") {
      continue;
    }
    const role = item.role.toLowerCase();
    if (role === "user") {
      sawAssistantReply = false;
    } else if (role === "assistant") {
      if (assistantGroupIsForwardedBoundary(item)) {
        // Gateway preserves sessions_send provenance when projecting inputs as assistant groups.
        // Those groups start a new autonomous turn; they are not replies to an earlier tool.
        sawAssistantReply = false;
      } else if (assistantGroupHasReplyText(item)) {
        sawAssistantReply = true;
      }
    } else if (role === "tool") {
      item.turnSucceeded = sawAssistantReply;
    }
  }
  return items;
}

function isPendingSendMessage(message: unknown): boolean {
  return asRecord(asRecord(message)?.["__openclaw"])?.kind === "pending-send";
}

function sourceMessageId(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) {
    return null;
  }
  const openclawId = asRecord(record["__openclaw"])?.id;
  if (typeof openclawId === "string" && openclawId.trim()) {
    return openclawId.trim();
  }
  const messageId = typeof record.messageId === "string" ? record.messageId.trim() : "";
  if (messageId) {
    return messageId;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  return id || null;
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
  if (role !== "assistant") {
    return null;
  }
  const id = sourceMessageId(message);
  return id ? `${role}:${id}` : null;
}

function prefersNativeChatSurface(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  return (role === "user" || role === "assistant") && !(normalized.senderLabel ?? "").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSenderLabelPrefix(text: string, senderLabel: string): string {
  const label = senderLabel.trim();
  if (!label) {
    return text;
  }
  return text.replace(new RegExp(`^${escapeRegExp(label)}(?::|：|-|—)?[ \\t]+`), "");
}

function sourceDuplicateDisplayParts(message: unknown): {
  role: string;
  senderLabel: string;
  text: string;
} | null {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (role !== "assistant") {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    textParts.push(block.text);
  }
  const text = textParts.join("\n");
  if (!text.trim()) {
    return null;
  }
  return {
    role,
    senderLabel: (normalized.senderLabel ?? "").trim(),
    text,
  };
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
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (!role || role === "tool") {
    return null;
  }
  if (normalized.content.length === 0) {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    textParts.push(block.text);
  }
  const text = textParts.join("\n").trim().replace(/\s+/g, " ");
  if (!text) {
    return null;
  }
  const senderLabel =
    role === "user" || role === "assistant" ? (normalized.senderLabel ?? "").trim() : "";
  return `${role}:${senderLabel}:${text}`;
}

function collapseSequentialDuplicateMessages(items: ChatItem[]): ChatItem[] {
  const collapsed: ChatItem[] = [];
  let previousSignature: string | null = null;
  let previousSourceKey: string | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      collapsed.push(item);
      previousSignature = null;
      previousSourceKey = null;
      continue;
    }
    const signature = collapseDuplicateDisplaySignature(item.message);
    const sourceKey = collapseDuplicateSourceKey(item.message);
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
      !(sourceKey && previousSourceKey && sourceKey !== previousSourceKey)
    ) {
      previous.duplicateCount = (previous.duplicateCount ?? 1) + 1;
      continue;
    }
    collapsed.push(item);
    previousSignature = signature;
    previousSourceKey = sourceKey;
  }

  return collapsed;
}

function hasRenderableNormalizedMessage(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role);
  const hasVisibleSenderLabel = role === "assistant" && Boolean(normalized.senderLabel?.trim());
  return normalized.content.length > 0 || Boolean(normalized.replyTarget) || hasVisibleSenderLabel;
}

function sanitizeStreamText(text: string): string {
  const stripped = stripMessageDisplayMetadataText(text);
  return stripped.trim().length > 0 ? stripped : "";
}

function shouldRenderQueuedSendInThread(item: ChatQueueItem): boolean {
  if (typeof item.sendSubmittedAtMs !== "number" || item.sendState === "failed") {
    return false;
  }
  return (
    item.sendState === "waiting-model" ||
    item.sendState === "waiting-idle" ||
    item.sendState === "sending" ||
    item.sendState === "waiting-reconnect"
  );
}

function queuedSendThreadMessage(item: ChatQueueItem): Record<string, unknown> | null {
  const content = buildUserChatMessageContentBlocks(item.text, item.attachments);
  if (content.length === 0) {
    return null;
  }
  return {
    role: "user",
    content,
    timestamp: item.createdAt,
    __openclaw: {
      kind: "pending-send",
      id: item.id,
      state: item.sendState,
    },
  };
}

function rawMessageTimestamp(message: unknown): number | null {
  const timestamp = asRecord(message)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function chatItemTimestamp(item: ChatItem): number | null {
  switch (item.kind) {
    case "message":
      return item.key === "chat:history:notice"
        ? Number.NEGATIVE_INFINITY
        : rawMessageTimestamp(item.message);
    case "divider":
      return item.timestamp;
    case "stream":
      return item.startedAt;
    case "reading-indicator":
      return null;
  }
  return null;
}

function timestampAfterVisibleItems(items: ChatItem[], desiredTimestamp: number): number {
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

function sortChatItemsByVisibleTime(
  items: ChatItem[],
  toolStreamPredecessors: ReadonlyMap<string, string>,
): ChatItem[] {
  const timestampsByKey = new Map<string, number>();
  for (const item of items) {
    const timestamp = chatItemTimestamp(item);
    if (timestamp != null) {
      timestampsByKey.set(item.key, timestamp);
    }
  }
  return items
    .map((item, index) => {
      const timestamp = chatItemTimestamp(item);
      const predecessorKey = toolStreamPredecessors.get(item.key);
      const predecessorTimestamp = predecessorKey ? timestampsByKey.get(predecessorKey) : null;
      return {
        item,
        index,
        predecessorKey,
        timestamp:
          timestamp != null && predecessorTimestamp != null
            ? Math.max(timestamp, predecessorTimestamp)
            : timestamp,
      };
    })
    .toSorted((a, b) => {
      if (a.timestamp == null && b.timestamp == null) {
        return a.index - b.index;
      }
      if (a.timestamp == null) {
        return 1;
      }
      if (b.timestamp == null) {
        return -1;
      }
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      if (a.predecessorKey === b.item.key) {
        return 1;
      }
      if (b.predecessorKey === a.item.key) {
        return -1;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

type RawContentEstimateState = {
  visited: WeakSet<object>;
  nodes: number;
};

const RAW_CONTENT_ESTIMATE_MAX_DEPTH = 8;
const RAW_CONTENT_ESTIMATE_MAX_NODES = 400;

function addCapped(total: number, amount: number, limit: number): number {
  return Math.min(limit, total + Math.max(0, amount));
}

function estimateRawContentChars(
  value: unknown,
  limit: number,
  state: RawContentEstimateState,
  depth = 0,
): number {
  if (limit <= 0) {
    return 0;
  }
  if (typeof value === "string") {
    return Math.min(value.length, limit);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (depth >= RAW_CONTENT_ESTIMATE_MAX_DEPTH || state.nodes >= RAW_CONTENT_ESTIMATE_MAX_NODES) {
    return 0;
  }
  if (state.visited.has(value)) {
    return 0;
  }
  state.visited.add(value);
  state.nodes += 1;

  if (Array.isArray(value)) {
    let chars = 0;
    for (const item of value) {
      chars = addCapped(
        chars,
        estimateRawContentChars(item, limit - chars, state, depth + 1),
        limit,
      );
      if (chars >= limit) {
        break;
      }
    }
    return chars;
  }

  const record = value as Record<string, unknown>;
  let chars = 0;
  for (const key of ["text", "content", "args", "arguments", "input"] as const) {
    chars = addCapped(
      chars,
      estimateRawContentChars(record[key], limit - chars, state, depth + 1),
      limit,
    );
    if (chars >= limit) {
      break;
    }
  }
  return chars;
}

function estimateMessageRenderChars(message: unknown, limit: number): number {
  const record = asRecord(message);
  if (!record) {
    return 1;
  }
  const state: RawContentEstimateState = { visited: new WeakSet<object>(), nodes: 0 };
  let chars = 0;
  for (const key of ["content", "text", "args", "arguments", "input"] as const) {
    chars = addCapped(chars, estimateRawContentChars(record[key], limit - chars, state), limit);
    if (chars >= limit) {
      break;
    }
  }
  return Math.max(chars, 1);
}

function isHiddenToolMessage(message: unknown, showToolCalls: boolean): boolean {
  if (showToolCalls) {
    return false;
  }
  return safeNormalizeMessage(message)?.role.toLowerCase() === "toolresult";
}

function countVisibleHistoryMessages(messages: unknown[], showToolCalls: boolean): number {
  let count = 0;
  for (const message of messages) {
    if (!isHiddenToolMessage(message, showToolCalls)) {
      count += 1;
    }
  }
  return count;
}

function resolveHistoryRenderLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return CHAT_HISTORY_RENDER_LIMIT;
  }
  return Math.max(1, Math.min(CHAT_HISTORY_RENDER_LIMIT, Math.floor(limit)));
}

function resolveHistoryStartIndex(
  messages: unknown[],
  showToolCalls: boolean,
  renderLimit: number,
): number {
  let visibleCount = 0;
  let renderChars = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isHiddenToolMessage(message, showToolCalls)) {
      continue;
    }
    if (visibleCount >= renderLimit) {
      break;
    }
    const remainingBudget = Math.max(1, CHAT_HISTORY_RENDER_CHAR_BUDGET - renderChars + 1);
    const messageChars = estimateMessageRenderChars(message, remainingBudget);
    if (visibleCount > 0 && renderChars + messageChars > CHAT_HISTORY_RENDER_CHAR_BUDGET) {
      break;
    }
    renderChars += messageChars;
    visibleCount += 1;
    startIndex = index;
  }
  return startIndex;
}

export function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const historyRenderLimit = resolveHistoryRenderLimit(props.historyRenderLimit);
  const history = (Array.isArray(props.messages) ? props.messages : []).filter(
    (message) => !isAssistantHeartbeatAckForDisplay(message),
  );
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const liftedCanvasSources = tools
    .map((tool) => extractChatMessagePreview(tool))
    .filter((entry) => Boolean(entry)) as Array<{
    preview: Extract<NonNullable<ToolCard["preview"]>, { kind: "canvas" }>;
    text: string | null;
    timestamp: number | null;
  }>;
  const historyStart = resolveHistoryStartIndex(history, props.showToolCalls, historyRenderLimit);
  const hiddenHistoryCount = countVisibleHistoryMessages(
    history.slice(0, historyStart),
    props.showToolCalls,
  );
  const visibleHistoryCount = countVisibleHistoryMessages(
    history.slice(historyStart),
    props.showToolCalls,
  );
  if (hiddenHistoryCount > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${visibleHistoryCount} messages (${hiddenHistoryCount} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = safeNormalizeMessage(msg);
    if (!normalized) {
      continue;
    }
    const raw = asRecord(msg) ?? {};
    const marker = raw["__openclaw"] as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compacted history",
        description:
          "The compacted transcript is preserved as a checkpoint. Open session checkpoints to branch or restore from that compacted view.",
        action: {
          kind: "session-checkpoints",
          label: "Open checkpoints",
        },
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showToolCalls && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    const searchQuery = props.searchQuery ?? "";
    if (props.searchOpen && searchQuery.trim() && !messageMatchesSearchQuery(msg, searchQuery)) {
      continue;
    }
    if (!hasRenderableNormalizedMessage(msg) && normalized.role.toLowerCase() !== "assistant") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  const queuedSends = Array.isArray(props.queue) ? props.queue : [];
  for (const queued of queuedSends) {
    if (!shouldRenderQueuedSendInThread(queued)) {
      continue;
    }
    const message = queuedSendThreadMessage(queued);
    if (!message) {
      continue;
    }
    const searchQuery = props.searchQuery ?? "";
    if (
      props.searchOpen &&
      searchQuery.trim() &&
      !messageMatchesSearchQuery(message, searchQuery)
    ) {
      continue;
    }
    items.push({
      kind: "message",
      key: `pending-send:${queued.id}`,
      message,
    });
  }
  for (const liftedCanvasSource of liftedCanvasSources) {
    const assistantIndex = findNearestAssistantMessageIndex(items, liftedCanvasSource.timestamp);
    if (assistantIndex == null) {
      continue;
    }
    const item = items[assistantIndex];
    if (!item || item.kind !== "message") {
      continue;
    }
    items[assistantIndex] = {
      ...item,
      message: appendCanvasBlockToAssistantMessage(
        item.message as Record<string, unknown>,
        liftedCanvasSource.preview,
        liftedCanvasSource.text,
      ),
    };
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const segments = props.streamSegments ?? [];
  const keyedSegments = segments.filter(streamSegmentHasItemId);
  const indexedSegments = segments.filter((segment) => !streamSegmentHasItemId(segment));
  const toolItems = tools.map((message, index) => ({
    key: messageKey(message, index + history.length),
    message,
  }));
  const toolKeysByCallId = new Map<string, string>();
  for (const tool of toolItems) {
    const toolCallId = asRecord(tool.message)?.toolCallId;
    if (typeof toolCallId === "string" && toolCallId.trim()) {
      toolKeysByCallId.set(toolCallId.trim(), tool.key);
    }
  }
  const maxLen = Math.max(indexedSegments.length, tools.length);
  let previousAccumulatedStreamText: string | null = null;
  const toolStreamPredecessors = new Map<string, string>();
  for (let i = 0; i < maxLen; i++) {
    if (i < indexedSegments.length) {
      const segment = indexedSegments[i];
      const text = sanitizeStreamText(segment.text);
      const usesAccumulatedText = streamSegmentUsesAccumulatedText(segment);
      const visibleText = usesAccumulatedText
        ? trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText)
        : text;
      if (usesAccumulatedText && text.length > 0) {
        previousAccumulatedStreamText = text;
      }
      if (visibleText.length > 0) {
        const streamKey = `stream-seg:${props.sessionKey}:${i}`;
        items.push({
          kind: "stream",
          key: streamKey,
          text: visibleText,
          startedAt: segment.ts,
          isStreaming: false,
        });
        const toolCallId = segment.toolCallId?.trim();
        const toolKey = toolCallId ? toolKeysByCallId.get(toolCallId) : undefined;
        if (toolKey) {
          // Gateway and browser clocks can disagree. Keep the assistant text that
          // introduced a tool causally before its card even when timestamps do not.
          toolStreamPredecessors.set(toolKey, streamKey);
        }
      }
    }
    const tool = toolItems[i];
    if (tool && props.showToolCalls) {
      items.push({
        kind: "message",
        key: tool.key,
        message: tool.message,
      });
    }
  }
  for (const segment of keyedSegments) {
    const text = sanitizeStreamText(segment.text);
    if (text.length === 0) {
      continue;
    }
    const commentaryItem: ChatItem = {
      kind: "stream",
      key: `stream-seg:${props.sessionKey}:${segment.itemId}`,
      text,
      startedAt: segment.ts,
      isStreaming: false,
    };
    // Merge keyed commentary into the timestamp ordering path instead of
    // appending it after every tool card. Insert before the first already-built
    // item whose visible timestamp is strictly later, so a preamble that
    // arrived before a later tool renders above that tool while the run is live
    // (not only after final materialization). Tools that share the commentary's
    // timestamp and are already visible stay above it.
    const insertionIndex = items.findIndex((existing) => {
      const existingTimestamp = chatItemTimestamp(existing);
      return existingTimestamp != null && existingTimestamp > segment.ts;
    });
    if (insertionIndex === -1) {
      items.push(commentaryItem);
    } else {
      items.splice(insertionIndex, 0, commentaryItem);
    }
  }

  // Working spark contract: whenever the agent works with nothing visibly
  // streaming (pre-first-token, or a queued send in flight), the thread shows
  // the reading indicator where the reply will materialize. Streaming text
  // and running tool rows take over as the signal once content flows.
  // A visible running tool row already signals active work, so the spark is
  // suppressed rather than stacked under it; hidden tool calls keep the spark.
  const hasVisibleRunningTool =
    props.showToolCalls &&
    tools.some((message) => {
      const record = asRecord(message);
      return (
        record?.["__openclawToolStreamLive"] === true &&
        record["__openclawToolStreamResultReceived"] !== true
      );
    });
  // The initial-load skeleton owns the empty thread; a background reload with
  // content still visible keeps the spark (it is the only working signal).
  const initialHistoryLoad = props.loading === true && items.length === 0;
  const hasPendingResponse =
    props.stream === null &&
    ((props.runWorking === true && !hasVisibleRunningTool && !initialHistoryLoad) ||
      queuedSends.some(
        (item) => item.sendState === "sending" && shouldRenderQueuedSendInThread(item),
      ));
  if (hasPendingResponse) {
    items.push({
      kind: "reading-indicator",
      key: `stream:${props.sessionKey}:pending`,
    });
  } else if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    const text = sanitizeStreamText(props.stream);
    const visibleText = trimAccumulatedStreamPrefix(text, previousAccumulatedStreamText);
    const startedAt = timestampAfterVisibleItems(items, props.streamStartedAt ?? Date.now());
    if (visibleText.length > 0) {
      if (!stripHeartbeatTokenForDisplay(visibleText).shouldSkip) {
        items.push({
          kind: "stream",
          key,
          text: visibleText,
          startedAt,
          isStreaming: true,
        });
      }
    } else if (props.stream.trim().length === 0) {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return annotateToolTurnOutcome(
    groupMessages(
      collapseSequentialDuplicateMessages(
        coalesceToolActivityMessages(sortChatItemsByVisibleTime(items, toolStreamPredecessors)),
      ),
    ),
  );
}

function sameChatItemsInput(previous: BuildChatItemsProps, next: BuildChatItemsProps): boolean {
  return (
    previous.sessionKey === next.sessionKey &&
    previous.messages === next.messages &&
    previous.toolMessages === next.toolMessages &&
    previous.streamSegments === next.streamSegments &&
    previous.stream === next.stream &&
    previous.streamStartedAt === next.streamStartedAt &&
    previous.queue === next.queue &&
    previous.showToolCalls === next.showToolCalls &&
    previous.runWorking === next.runWorking &&
    previous.loading === next.loading &&
    previous.searchOpen === next.searchOpen &&
    previous.searchQuery === next.searchQuery &&
    previous.historyRenderLimit === next.historyRenderLimit
  );
}

export function buildCachedChatItems(
  input: BuildChatItemsProps,
): ReturnType<typeof buildChatItems> {
  const cached = getOrCreateSessionCacheValue(chatItemsBySession, input.sessionKey, () => ({
    input: null,
    items: [],
  }));
  if (cached.input && sameChatItemsInput(cached.input, input)) {
    return cached.items;
  }
  const items = buildChatItems(input);
  cached.input = input;
  cached.items = items;
  return items;
}

export function coalesceStreamRuns(
  items: ReturnType<typeof buildChatItems>,
): Array<RenderChatItem | StreamRunRenderItem> {
  const result: Array<RenderChatItem | StreamRunRenderItem> = [];
  let run: StreamRunRenderItem["parts"] = [];
  // Contiguous in-flight stream and reading-indicator items render under one
  // assistant avatar; messages, groups, and dividers intentionally break the run.
  const flush = () => {
    const [first] = run;
    if (first) {
      result.push({ kind: "stream-run", key: `stream-run:${first.key}`, parts: run });
      run = [];
    }
  };
  for (const item of items) {
    if (item.kind === "stream" || item.kind === "reading-indicator") {
      run.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}

export function deletedChatItemsSignature(
  deleted: { has: (key: string) => boolean },
  chatItems: ReturnType<typeof buildChatItems>,
): string {
  const deletedKeys = chatItems
    .map((item) => item.key)
    .filter((key) => deleted.has(key))
    .toSorted();
  return deletedKeys.length === 0 ? "" : deletedKeys.join("\u0000");
}

export function stableBooleanMapSignature(values: ReadonlyMap<string, boolean>): string {
  if (values.size === 0) {
    return "";
  }
  return Array.from(values)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value ? "1" : "0"}`)
    .join("\u0000");
}

export function getExpandedToolCards(sessionKey: string): Map<string, boolean> {
  return getOrCreateSessionCacheValue(expandedToolCardsBySession, sessionKey, () => new Map());
}

function getInitializedToolCards(sessionKey: string): Set<string> {
  return getOrCreateSessionCacheValue(initializedToolCardsBySession, sessionKey, () => new Set());
}

export function syncToolCardExpansionState(
  sessionKey: string,
  items: Array<ChatItem | MessageGroup>,
  autoExpandToolCalls: boolean,
): void {
  const expanded = getExpandedToolCards(sessionKey);
  const initialized = getInitializedToolCards(sessionKey);
  const previousAutoExpand = lastAutoExpandPrefBySession.get(sessionKey) ?? false;
  const currentToolCardIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "group") {
      continue;
    }
    for (const entry of item.messages) {
      const cards = extractToolCardsCached(entry.message, entry.key);
      for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
        const disclosureId = `${entry.key}:toolcard:${cardIndex}`;
        currentToolCardIds.add(disclosureId);
        if (initialized.has(disclosureId)) {
          continue;
        }
        expanded.set(disclosureId, autoExpandToolCalls);
        initialized.add(disclosureId);
      }
      if (!isStandaloneToolMessageForDisplay(entry.message)) {
        continue;
      }
      const disclosureId = `toolmsg:${entry.key}`;
      currentToolCardIds.add(disclosureId);
      if (initialized.has(disclosureId)) {
        continue;
      }
      expanded.set(disclosureId, autoExpandToolCalls);
      initialized.add(disclosureId);
    }
  }
  if (autoExpandToolCalls && !previousAutoExpand) {
    for (const toolCardId of currentToolCardIds) {
      expanded.set(toolCardId, true);
    }
  }
  lastAutoExpandPrefBySession.set(sessionKey, autoExpandToolCalls);
}

function messageKey(message: unknown, index: number): string {
  const m = asRecord(message) ?? {};
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    const role = typeof m.role === "string" ? m.role : "unknown";
    const id = typeof m.id === "string" ? m.id : "";
    if (id) {
      return `tool:${role}:${toolCallId}:${id}`;
    }
    const messageId = typeof m.messageId === "string" ? m.messageId : "";
    if (messageId) {
      return `tool:${role}:${toolCallId}:${messageId}`;
    }
    const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
    if (timestamp != null) {
      return `tool:${role}:${toolCallId}:${timestamp}:${index}`;
    }
    return `tool:${role}:${toolCallId}:${index}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
