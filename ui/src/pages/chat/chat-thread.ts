// Control UI chat module owns Chat thread item derivation and thread-local caches.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type {
  ChatItem,
  MessageGroup,
  NormalizedMessage,
  ToolCard,
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
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import {
  extractToolCardsCached,
  extractToolPreview,
  isToolCardError,
} from "../../lib/chat/tool-cards.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import {
  buildCompactionDividerItem,
  clearWorkingStartedAt,
  resetWorkingStartedAt,
  resolveWorkingStartedAt,
  shouldRenderQueuedSendInThread,
} from "./chat-progress.ts";
import { getOrCreateSessionCacheValue } from "./session-cache.ts";
import type { PlanStatus } from "./tool-stream.ts";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

type BuildChatItemsProps = {
  paneId: string;
  sessionKey: string;
  runId?: string | null;
  /** Invalidates cached display copy when the active UI language changes. */
  locale?: string;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  queue?: ChatQueueItem[];
  showToolCalls: boolean;
  /** True while the agent is visibly working (isChatRunWorking). */
  runWorking?: boolean;
  /** True while the current session has an abortable live run. */
  runActive?: boolean;
  planStatus?: PlanStatus | null;
  questionPrompts?: readonly QuestionPrompt[];
  /** True while chat history is loading (initial load or background reload). */
  loading?: boolean;
  searchOpen?: boolean;
  searchQuery?: string;
};

type CachedChatItems = {
  input: BuildChatItemsProps | null;
  items: ReturnType<typeof buildChatItems>;
  liveStreamIndex: number;
  liveStreamPrefix: string | null;
};

type RenderChatItem = ReturnType<typeof buildChatItems>[number];
type StreamRunRenderItem = {
  kind: "stream-run";
  key: string;
  parts: Array<
    Extract<
      ChatItem,
      { kind: "stream" } | { kind: "reading-indicator" } | { kind: "question" } | { kind: "plan" }
    >
  >;
};

const chatItemsByPane = new Map<string, Map<string, CachedChatItems>>();
const expandedToolCardsBySession = new Map<string, Map<string, boolean>>();
const initializedToolCardsBySession = new Map<string, Set<string>>();
const lastAutoExpandPrefBySession = new Map<string, boolean>();

export function resetChatThreadState(paneId?: string): void {
  if (paneId) {
    chatItemsByPane.delete(paneId);
    return;
  }
  chatItemsByPane.clear();
  resetWorkingStartedAt();
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

function turnHasMatchingAssistant(
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

function extractChatMessagePreview(toolMessage: unknown): ChatMessagePreview | null {
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

function canvasPreviewBaseIdentity(message: unknown, source: ChatMessagePreview): string | null {
  const toolCallId = resolveMessageToolUseId(asRecord(message) ?? {});
  const previewId = source.preview.viewId ?? source.preview.url;
  return toolCallId && previewId ? JSON.stringify([toolCallId, previewId]) : null;
}

function createCanvasAssistantMessage(
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

function transcriptPositionTimestamp(messages: unknown[], sourceIndex: number): number | null {
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

function findNearestAssistantMessageIndex(
  items: ChatItem[],
  toolTimestamp: number | null,
): number | null {
  let currentTurnStart = 0;
  let currentTurnEnd = items.length;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== "message") {
      continue;
    }
    const normalized = safeNormalizeMessage(item.message);
    if (!normalized || normalizeRoleForGrouping(normalized.role).toLowerCase() !== "user") {
      continue;
    }
    if (
      toolTimestamp != null &&
      normalized.timestamp != null &&
      normalized.timestamp > toolTimestamp
    ) {
      currentTurnEnd = index;
      break;
    }
    if (
      toolTimestamp == null ||
      normalized.timestamp == null ||
      normalized.timestamp <= toolTimestamp
    ) {
      currentTurnStart = index + 1;
    }
  }
  const assistantEntries = items
    .map((item, index) => {
      if (index < currentTurnStart || index >= currentTurnEnd || item.kind !== "message") {
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

function findCanvasInsertionIndex(items: ChatItem[], toolTimestamp: number | null): number {
  if (toolTimestamp == null) {
    return items.length;
  }
  for (let index = 0; index < items.length; index += 1) {
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
  return items.length;
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
    const sender = role.toLowerCase() === "user" ? normalized.sender : undefined;
    const timestamp = normalized.timestamp || Date.now();
    const shouldSplitBySender = role.toLowerCase() === "user" || role.toLowerCase() === "assistant";
    const startsProjectedTurn =
      asRecord(asRecord(item.message)?.["__openclaw"])?.turnBoundary === true;

    if (
      !currentGroup ||
      startsProjectedTurn ||
      currentGroup.role !== role ||
      (shouldSplitBySender &&
        (currentGroup.senderLabel !== senderLabel ||
          senderIdentityKey(currentGroup.sender) !== senderIdentityKey(sender)))
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        ...(sender ? { sender } : {}),
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
  const item = coalesced[callIndex];
  if (!item) {
    return;
  }
  for (const callId of unresolvedToolCallIds(item)) {
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
      const callItem = callIndex === undefined ? undefined : coalesced[callIndex];
      const merged =
        callIndex === undefined || !callItem ? null : mergeToolCallResultPair(callItem, resultItem);
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
      const previous = previousIndex === undefined ? undefined : coalesced[previousIndex];
      if (previousIndex !== undefined && previous && unresolvedToolCallIds(previous).size === 1) {
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
  return group.messages.some(({ message }) => {
    if (extractTextCached(message)?.trim()) {
      return true;
    }
    return safeNormalizeMessage(message)?.content.some((block) => block.type === "canvas") ?? false;
  });
}

function assistantGroupIsForwardedBoundary(group: MessageGroup): boolean {
  return group.messages.some(({ message }) => {
    const provenance = asRecord(asRecord(message)?.provenance);
    return provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send";
  });
}

function groupStartsProjectedTurnBoundary(group: MessageGroup): boolean {
  return asRecord(asRecord(group.messages[0]?.message)?.["__openclaw"])?.turnBoundary === true;
}

function annotateToolTurnOutcome(
  items: Array<ChatItem | MessageGroup>,
): Array<ChatItem | MessageGroup> {
  let sawAssistantReply = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.kind !== "group") {
      continue;
    }
    const role = item.role.toLowerCase();
    const forwardedBoundary = role === "assistant" && assistantGroupIsForwardedBoundary(item);
    const projectedBoundary = groupStartsProjectedTurnBoundary(item);
    if (role === "user") {
      sawAssistantReply = false;
    } else if (role === "assistant") {
      if (forwardedBoundary) {
        // Gateway preserves sessions_send provenance when projecting inputs as assistant groups.
        // Those groups start a new autonomous turn; they are not replies to an earlier tool.
        sawAssistantReply = false;
      } else if (assistantGroupHasReplyText(item)) {
        sawAssistantReply = true;
      }
    } else if (role === "tool") {
      item.turnSucceeded = sawAssistantReply;
    }
    if (role !== "user" && !forwardedBoundary && projectedBoundary) {
      // This group belongs to the new hidden-input turn. Reset only after
      // processing it so replies from this turn cannot classify older tools.
      sawAssistantReply = false;
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

export function persistedMessageEntryId(message: unknown): string | null {
  return isPendingSendMessage(message) ? null : sourceMessageId(message);
}

function transcriptMessageSourceKey(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) {
    return null;
  }
  const id = sourceMessageId(message);
  if (id) {
    return `id:${id}`;
  }
  const seq = asRecord(record["__openclaw"])?.seq;
  const normalizedSeq =
    typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : null;
  return normalizedSeq == null ? null : `seq:${normalizedSeq}`;
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
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const digest = `p${(hash >>> 0).toString(36)}${source.length.toString(36)}`;
  if (message && typeof message === "object") {
    messageProjectionDigests.set(message, digest);
  }
  return digest;
}

function buildMessageKeys(messages: unknown[], indexOffset = 0): string[] {
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
      ...(item.sender?.id ? { senderId: item.sender.id } : {}),
      ...(item.sender?.name ? { senderName: item.sender.name } : {}),
      ...(item.sender?.username ? { senderUsername: item.sender.username } : {}),
      ...(item.sender?.profileAvatarUrl
        ? { senderProfileAvatarUrl: item.sender.profileAvatarUrl }
        : {}),
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
      return rawMessageTimestamp(item.message);
    case "divider":
      return item.timestamp;
    case "stream":
      return item.startedAt;
    case "question":
      return item.startedAt;
    case "reading-indicator":
    case "plan":
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

function buildChatItems(props: BuildChatItemsProps): Array<ChatItem | MessageGroup> {
  let items: ChatItem[] = [];
  const history = (Array.isArray(props.messages) ? props.messages : []).filter(
    (message) => !isAssistantHeartbeatAckForDisplay(message),
  );
  const tools = Array.isArray(props.toolMessages)
    ? props.toolMessages.filter((message) => asRecord(message) !== null)
    : [];
  const historyKeys = buildMessageKeys(history);
  const toolKeys = buildMessageKeys(tools, history.length);
  const liftedCanvasSources = tools.flatMap((message, index) => {
    const source = extractChatMessagePreview(message);
    return source ? [{ ...source, message, index }] : [];
  });
  const searchFiltering = props.searchOpen === true && Boolean(props.searchQuery?.trim());
  const persistedCanvasIdentities = new Set<string>();
  for (const message of history) {
    const source = extractChatMessagePreview(message);
    if (!source) {
      continue;
    }
    const baseIdentity = canvasPreviewBaseIdentity(message, source);
    if (baseIdentity) {
      // fetchMcpAppView assigns a fresh viewId to every invocation. Matching the call and
      // view therefore identifies the same preview while still tolerating a reused call ID.
      persistedCanvasIdentities.add(baseIdentity);
    }
  }
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const itemKey = historyKeys[i] ?? messageKey(msg, i);
    const normalized = safeNormalizeMessage(msg);
    if (!normalized) {
      continue;
    }
    const raw = asRecord(msg) ?? {};
    const marker = raw["__openclaw"] as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push(buildCompactionDividerItem(marker, normalized.timestamp ?? Date.now(), i));
      continue;
    }

    const isToolResult = normalized.role.toLowerCase() === "toolresult";
    const persistedCanvasSource = isToolResult ? extractChatMessagePreview(msg) : null;
    const renderPersistedPreview =
      persistedCanvasSource != null &&
      (!searchFiltering || turnHasMatchingAssistant(history, i, props.searchQuery ?? ""));
    if (persistedCanvasSource && renderPersistedPreview) {
      items.push({
        kind: "message",
        key: `${itemKey}:canvas`,
        message: createCanvasAssistantMessage(
          persistedCanvasSource,
          persistedCanvasSource.timestamp ?? transcriptPositionTimestamp(history, i),
        ),
      });
    }

    if (!props.showToolCalls && isToolResult) {
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
      key: itemKey,
      message: msg,
    });
  }
  const queuedSends = Array.isArray(props.queue) ? props.queue : [];
  const activeRunQueuedSends = queuedSends.filter((queued) => queued.sendState === "waiting-model");
  const futureQueuedSends = queuedSends.filter((queued) => !activeRunQueuedSends.includes(queued));
  const futureQueuedTimestamp = futureQueuedSends.reduce<number | null>(
    (earliest, queued) =>
      earliest == null ? queued.createdAt : Math.min(earliest, queued.createdAt),
    null,
  );
  const appendQueuedSend = (queued: ChatQueueItem) => {
    if (!shouldRenderQueuedSendInThread(queued)) {
      return;
    }
    const message = queuedSendThreadMessage(queued);
    if (!message) {
      return;
    }
    const searchQuery = props.searchQuery ?? "";
    if (
      props.searchOpen &&
      searchQuery.trim() &&
      !messageMatchesSearchQuery(message, searchQuery)
    ) {
      return;
    }
    items.push({
      kind: "message",
      key: `pending-send:${queued.id}`,
      message,
    });
  };
  for (const queued of activeRunQueuedSends) {
    appendQueuedSend(queued);
  }
  for (const liftedCanvasSource of liftedCanvasSources) {
    const baseIdentity = canvasPreviewBaseIdentity(liftedCanvasSource.message, liftedCanvasSource);
    if (baseIdentity && persistedCanvasIdentities.has(baseIdentity)) {
      continue;
    }
    const assistantIndex = findNearestAssistantMessageIndex(items, liftedCanvasSource.timestamp);
    if (assistantIndex == null) {
      if (searchFiltering) {
        continue;
      }
      const insertionIndex = findCanvasInsertionIndex(items, liftedCanvasSource.timestamp);
      const nextItem = items[insertionIndex];
      const nextTimestamp =
        nextItem?.kind === "message" ? rawMessageTimestamp(nextItem.message) : null;
      const boundaryTimestamp =
        nextTimestamp == null
          ? futureQueuedTimestamp
          : futureQueuedTimestamp == null
            ? nextTimestamp
            : Math.min(nextTimestamp, futureQueuedTimestamp);
      const timestamp =
        liftedCanvasSource.timestamp != null && boundaryTimestamp != null
          ? Math.min(liftedCanvasSource.timestamp, boundaryTimestamp)
          : liftedCanvasSource.timestamp;
      items.splice(insertionIndex, 0, {
        kind: "message",
        key: `${
          toolKeys[liftedCanvasSource.index] ??
          messageKey(liftedCanvasSource.message, liftedCanvasSource.index + history.length)
        }:canvas`,
        message: createCanvasAssistantMessage(liftedCanvasSource, timestamp),
      });
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
  for (const queued of futureQueuedSends) {
    appendQueuedSend(queued);
  }
  items = items.filter(
    (item) => item.kind !== "message" || hasRenderableNormalizedMessage(item.message),
  );
  const segments = props.streamSegments ?? [];
  const keyedSegments = segments.filter(streamSegmentHasItemId);
  const indexedSegments = segments.filter((segment) => !streamSegmentHasItemId(segment));
  const toolItems = tools.map((message, index) => ({
    key: toolKeys[index] ?? messageKey(message, index + history.length),
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
      if (!segment) {
        continue;
      }
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
  if (props.runWorking !== true && props.stream === null && !hasPendingResponse) {
    clearWorkingStartedAt(props.sessionKey);
  }
  if (hasPendingResponse) {
    items.push({
      kind: "reading-indicator",
      key: `stream:${props.sessionKey}:pending`,
      startedAt: resolveWorkingStartedAt(
        props.sessionKey,
        props.runId ?? null,
        props.streamStartedAt,
        queuedSends,
        segments,
        tools,
      ),
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
      items.push({ kind: "reading-indicator", key, startedAt });
    }
  }
  if (props.runActive === true && props.planStatus && props.planStatus.steps.length > 0) {
    items.push({ kind: "plan", key: `plan:${props.sessionKey}:active` });
  }
  for (const prompt of props.questionPrompts ?? []) {
    // Pending questions live in the composer dock. Only their terminal summary becomes transcript.
    if (
      prompt.status === "pending" ||
      !prompt.sessionKey ||
      !areUiSessionKeysEquivalent(prompt.sessionKey, props.sessionKey)
    ) {
      continue;
    }
    items.push({
      kind: "question",
      key: `question:${prompt.id}`,
      questionId: prompt.id,
      startedAt: prompt.createdAtMs,
    });
  }

  return annotateToolTurnOutcome(
    groupMessages(
      collapseSequentialDuplicateMessages(
        coalesceToolActivityMessages(sortChatItemsByVisibleTime(items, toolStreamPredecessors)),
      ),
    ),
  );
}

function sameMessageGroup(previous: MessageGroup, next: MessageGroup): boolean {
  // Source message identity owns the row timestamp too: normalization supplies
  // Date.now() for missing timestamps, which must not churn stable rows.
  return (
    previous.role === next.role &&
    previous.senderLabel === next.senderLabel &&
    senderIdentityKey(previous.sender) === senderIdentityKey(next.sender) &&
    previous.isStreaming === next.isStreaming &&
    previous.turnSucceeded === next.turnSucceeded &&
    previous.messages.length === next.messages.length &&
    previous.messages.every((entry, index) => {
      const candidate = next.messages[index];
      return (
        candidate !== undefined &&
        entry.key === candidate.key &&
        entry.message === candidate.message &&
        entry.duplicateCount === candidate.duplicateCount
      );
    })
  );
}

function sameChatItem(previous: RenderChatItem, next: RenderChatItem): boolean {
  if (previous.kind !== next.kind || previous.key !== next.key) {
    return false;
  }
  switch (next.kind) {
    case "group":
      return previous.kind === "group" && sameMessageGroup(previous, next);
    case "message":
      return (
        previous.kind === "message" &&
        previous.message === next.message &&
        previous.duplicateCount === next.duplicateCount
      );
    case "divider":
      return (
        previous.kind === "divider" &&
        previous.label === next.label &&
        previous.metric === next.metric &&
        previous.description === next.description &&
        previous.timestamp === next.timestamp &&
        previous.action?.kind === next.action?.kind &&
        previous.action?.label === next.action?.label
      );
    case "stream":
      return (
        previous.kind === "stream" &&
        previous.text === next.text &&
        previous.startedAt === next.startedAt &&
        previous.isStreaming === next.isStreaming
      );
    case "reading-indicator":
      return previous.kind === "reading-indicator" && previous.startedAt === next.startedAt;
    case "question":
      return (
        previous.kind === "question" &&
        previous.questionId === next.questionId &&
        previous.startedAt === next.startedAt
      );
    case "plan":
      return previous.kind === "plan";
  }
  return false;
}

function stabilizeChatItems(
  previous: ReturnType<typeof buildChatItems>,
  next: ReturnType<typeof buildChatItems>,
): ReturnType<typeof buildChatItems> {
  if (previous.length === 0 || next.length === 0) {
    return next;
  }
  // Same-role groups can grow at either edge. Preserve the existing row key
  // when loaded-history arrays retain message objects across prepend or append.
  const previousGroupByMessage = new WeakMap<object, MessageGroup>();
  const previousGroupByMessageKey = new Map<string, MessageGroup>();
  for (const item of previous) {
    if (item.kind !== "group") {
      continue;
    }
    for (const message of item.messages) {
      if (message.message && typeof message.message === "object") {
        previousGroupByMessage.set(message.message, item);
      }
      previousGroupByMessageKey.set(message.key, item);
    }
  }
  const nextNaturalGroupKeys = new Set(
    next.filter((item) => item.kind === "group").map((item) => item.key),
  );
  const claimedGroupKeys = new Set<string>();
  const reconciled = next.map((item) => {
    if (item.kind !== "group") {
      return item;
    }
    const candidates = new Map<MessageGroup, { overlap: number; lastMatchIndex: number }>();
    for (const [index, message] of item.messages.entries()) {
      const prior =
        message.message && typeof message.message === "object"
          ? (previousGroupByMessage.get(message.message) ??
            previousGroupByMessageKey.get(message.key))
          : previousGroupByMessageKey.get(message.key);
      if (
        !prior ||
        claimedGroupKeys.has(prior.key) ||
        prior.role !== item.role ||
        prior.senderLabel !== item.senderLabel ||
        senderIdentityKey(prior.sender) !== senderIdentityKey(item.sender)
      ) {
        continue;
      }
      const candidate = candidates.get(prior);
      candidates.set(prior, {
        overlap: (candidate?.overlap ?? 0) + 1,
        lastMatchIndex: index,
      });
    }
    let best: { group: MessageGroup; overlap: number; lastMatchIndex: number } | null = null;
    for (const [group, candidate] of candidates) {
      if (
        !best ||
        candidate.overlap > best.overlap ||
        (candidate.overlap === best.overlap && candidate.lastMatchIndex > best.lastMatchIndex)
      ) {
        best = { group, ...candidate };
      }
    }
    if (!best) {
      return item;
    }
    if (best.group.key !== item.key && nextNaturalGroupKeys.has(best.group.key)) {
      return item;
    }
    claimedGroupKeys.add(best.group.key);
    return item.key === best.group.key ? item : { ...item, key: best.group.key };
  });
  const previousByKey = new Map(previous.map((item) => [`${item.kind}\u0000${item.key}`, item]));
  const stabilized = reconciled.map((item) => {
    const prior = previousByKey.get(`${item.kind}\u0000${item.key}`);
    return prior && sameChatItem(prior, item) ? prior : item;
  });
  return stabilized.length === previous.length &&
    stabilized.every((item, index) => item === previous[index])
    ? previous
    : stabilized;
}

function sameChatItemsStructuralInput(
  previous: BuildChatItemsProps,
  next: BuildChatItemsProps,
): boolean {
  return (
    previous.sessionKey === next.sessionKey &&
    previous.runId === next.runId &&
    previous.locale === next.locale &&
    previous.messages === next.messages &&
    previous.toolMessages === next.toolMessages &&
    previous.streamSegments === next.streamSegments &&
    previous.streamStartedAt === next.streamStartedAt &&
    previous.queue === next.queue &&
    previous.showToolCalls === next.showToolCalls &&
    previous.runWorking === next.runWorking &&
    previous.runActive === next.runActive &&
    previous.questionPrompts === next.questionPrompts &&
    Boolean(previous.planStatus?.steps.length) === Boolean(next.planStatus?.steps.length) &&
    previous.loading === next.loading &&
    previous.searchOpen === next.searchOpen &&
    previous.searchQuery === next.searchQuery
  );
}

function sameChatItemsInput(previous: BuildChatItemsProps, next: BuildChatItemsProps): boolean {
  return previous.stream === next.stream && sameChatItemsStructuralInput(previous, next);
}

function sameChatItemsInputExceptStream(
  previous: BuildChatItemsProps,
  next: BuildChatItemsProps,
): boolean {
  return (
    previous.stream !== null && next.stream !== null && sameChatItemsStructuralInput(previous, next)
  );
}

function accumulatedIndexedStreamText(segments: readonly ChatStreamSegment[]): string | null {
  let accumulated: string | null = null;
  for (const segment of segments) {
    if (streamSegmentHasItemId(segment) || !streamSegmentUsesAccumulatedText(segment)) {
      continue;
    }
    const text = sanitizeStreamText(segment.text);
    if (text.length > 0) {
      accumulated = text;
    }
  }
  return accumulated;
}

function updateCachedLiveStream(
  items: ReturnType<typeof buildChatItems>,
  index: number,
  accumulatedPrefix: string | null,
  input: BuildChatItemsProps,
): boolean {
  const item = items[index];
  if (item?.kind !== "stream" || !item.isStreaming) {
    return false;
  }
  const expectedKey = `stream:${input.sessionKey}:${input.streamStartedAt ?? "live"}`;
  if (item.key !== expectedKey || input.stream === null) {
    return false;
  }
  const text = trimAccumulatedStreamPrefix(sanitizeStreamText(input.stream), accumulatedPrefix);
  if (text.length === 0 || stripHeartbeatTokenForDisplay(text).shouldSkip) {
    return false;
  }
  items[index] = { ...item, text };
  return true;
}

function findLiveStreamIndex(items: ReturnType<typeof buildChatItems>): number {
  return items.findIndex((item) => item.kind === "stream" && item.isStreaming);
}

export function buildCachedChatItems(
  input: BuildChatItemsProps,
): ReturnType<typeof buildChatItems> {
  let paneCache = chatItemsByPane.get(input.paneId);
  if (!paneCache) {
    paneCache = new Map();
    chatItemsByPane.set(input.paneId, paneCache);
  }
  const cached = getOrCreateSessionCacheValue(paneCache, input.sessionKey, () => ({
    input: null,
    items: [],
    liveStreamIndex: -1,
    liveStreamPrefix: null,
  }));
  if (cached.input && sameChatItemsInput(cached.input, input)) {
    return cached.items;
  }
  // Streaming updates are the hottest transcript path. When every structural
  // input is unchanged, update the owned live row without rescanning
  // loaded history; shape changes still use the canonical full builder.
  if (
    cached.input &&
    sameChatItemsInputExceptStream(cached.input, input) &&
    updateCachedLiveStream(cached.items, cached.liveStreamIndex, cached.liveStreamPrefix, input)
  ) {
    cached.input = input;
    return cached.items;
  }
  const items = stabilizeChatItems(cached.items, buildChatItems(input));
  cached.input = input;
  cached.items = items;
  cached.liveStreamIndex = findLiveStreamIndex(items);
  cached.liveStreamPrefix = accumulatedIndexedStreamText(input.streamSegments);
  return items;
}

export function coalesceStreamRuns(
  items: ReturnType<typeof buildChatItems>,
): Array<RenderChatItem | StreamRunRenderItem> {
  const result: Array<RenderChatItem | StreamRunRenderItem> = [];
  let run: StreamRunRenderItem["parts"] = [];
  // Contiguous in-flight stream, plan, and reading-indicator items render under one
  // assistant avatar; messages, groups, and dividers intentionally break the run.
  const flush = () => {
    const [first] = run;
    if (first) {
      result.push({ kind: "stream-run", key: `stream-run:${first.key}`, parts: run });
      run = [];
    }
  };
  for (const item of items) {
    if (item.kind === "stream" || item.kind === "reading-indicator" || item.kind === "plan") {
      run.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}

/** Collapsed rollup of a completed turn's intermediate work (tools, commentary). */
type WorkGroupRenderItem = {
  kind: "work-group";
  key: string;
  groups: MessageGroup[];
  durationMs: number | null;
  hasError: boolean;
};

type TurnRenderItem = RenderChatItem | StreamRunRenderItem;

function isTurnBoundaryGroup(item: TurnRenderItem): boolean {
  if (item.kind !== "group") {
    return false;
  }
  const role = item.role.toLowerCase();
  // sessions_send projections start a new autonomous turn, same contract as
  // annotateToolTurnOutcome; they are inputs, not work produced by this turn.
  return (
    role === "user" ||
    groupStartsProjectedTurnBoundary(item) ||
    (role === "assistant" && assistantGroupIsForwardedBoundary(item))
  );
}

function isCollapsibleWorkGroup(item: TurnRenderItem): item is MessageGroup {
  if (item.kind !== "group" || item.isStreaming) {
    return false;
  }
  const role = item.role.toLowerCase();
  return role === "tool" || (role === "assistant" && !assistantGroupIsForwardedBoundary(item));
}

// Attachment/canvas/media-only replies carry no text but are still the turn's
// visible outcome; they must never fold into the work rollup. Normalized
// content passes unknown block types through (e.g. raw image blocks), so
// anything that is not a tool block counts as visible reply content.
function assistantGroupHasVisibleReplyContent(group: MessageGroup): boolean {
  return group.messages.some(({ message }) => {
    if (extractTextCached(message)?.trim()) {
      return true;
    }
    const content = safeNormalizeMessage(message)?.content ?? [];
    return content.some((block) => {
      if (block.type === "text") {
        return Boolean(block.text?.trim());
      }
      return !isToolCallContentType(block.type) && !isToolResultContentType(block.type);
    });
  });
}

// History carries no final-vs-commentary marker (commentary exists only as
// live stream segments), so the last assistant group with visible content
// stands in for the final reply. Turns whose last content is commentary
// merely collapse less; the visible reply is never folded away.
function isFinalReplyGroup(item: TurnRenderItem): boolean {
  return (
    isCollapsibleWorkGroup(item) &&
    item.role.toLowerCase() === "assistant" &&
    assistantGroupHasVisibleReplyContent(item)
  );
}

function workGroupHasError(groups: MessageGroup[]): boolean {
  return groups.some(
    (group) =>
      group.role.toLowerCase() === "tool" &&
      group.turnSucceeded !== true &&
      group.messages.some((entry) =>
        extractToolCardsCached(entry.message, entry.key).some(isToolCardError),
      ),
  );
}

/**
 * Once a turn is done, its intermediate work (tool groups and assistant
 * commentary before the final reply) collapses behind one "Worked for X"
 * disclosure so the thread reads final-output-first. Live turns stay fully
 * expanded; the collapse itself is the done signal.
 */
export function collapseCompletedTurnWork(
  items: TurnRenderItem[],
  opts: { runWorking: boolean; searchActive?: boolean },
): Array<TurnRenderItem | WorkGroupRenderItem> {
  // Chat search filters the thread to matching messages; folding a match into
  // a collapsed rollup would hide the very row the query found.
  if (opts.searchActive) {
    return items;
  }
  const turns: TurnRenderItem[][] = [];
  let currentTurn: TurnRenderItem[] = [];
  for (const item of items) {
    if (isTurnBoundaryGroup(item) && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(item);
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  const result: Array<TurnRenderItem | WorkGroupRenderItem> = [];
  for (const [turnIndex, turn] of turns.entries()) {
    // In-flight content (stream runs, streaming groups) marks the turn live.
    // While the run works, the trailing turn also stays expanded so activity
    // is watchable until the terminal rebuild collapses it.
    const isLive =
      (opts.runWorking && turnIndex === turns.length - 1) ||
      turn.some(
        (item) => item.kind === "stream-run" || (item.kind === "group" && item.isStreaming),
      );
    if (isLive) {
      result.push(...turn);
      continue;
    }
    let finalReplyIndex = -1;
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      const candidate = turn[index];
      if (candidate && isFinalReplyGroup(candidate)) {
        finalReplyIndex = index;
        break;
      }
    }
    // Without a final reply, the tool rows are the turn's only visible result.
    // Keep them exposed instead of replacing the result with an opaque rollup.
    if (finalReplyIndex === -1) {
      result.push(...turn);
      continue;
    }
    const segmentEnd = finalReplyIndex - 1;
    let segmentStart = segmentEnd + 1;
    for (let index = segmentEnd; index >= 0; index -= 1) {
      const candidate = turn[index];
      if (!candidate || !isCollapsibleWorkGroup(candidate)) {
        break;
      }
      segmentStart = index;
    }
    const groups = turn.slice(segmentStart, segmentEnd + 1) as MessageGroup[];
    const firstGroup = groups[0];
    if (!firstGroup) {
      result.push(...turn);
      continue;
    }
    const boundary = turn[0];
    const startTimestamp =
      boundary && boundary.kind === "group" && isTurnBoundaryGroup(boundary)
        ? boundary.timestamp
        : firstGroup.timestamp;
    const finalReply = turn[finalReplyIndex] as MessageGroup;
    const endTimestamp = finalReply.timestamp;
    const durationMs = endTimestamp > startTimestamp ? endTimestamp - startTimestamp : null;
    result.push(...turn.slice(0, segmentStart));
    result.push({
      kind: "work-group",
      // The final reply survives older-history prepends; the first work row does not.
      key: `work:${finalReply.key}`,
      groups,
      durationMs,
      hasError: workGroupHasError(groups),
    });
    result.push(...turn.slice(segmentEnd + 1));
  }
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

function messageKey(message: unknown, index: number, transcriptKey?: string): string {
  const m = asRecord(message) ?? {};
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    const role = typeof m.role === "string" ? m.role : "unknown";
    if (transcriptKey) {
      return `tool:${role}:${toolCallId}:${transcriptKey}`;
    }
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
  if (transcriptKey) {
    return `msg:${transcriptKey}`;
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
