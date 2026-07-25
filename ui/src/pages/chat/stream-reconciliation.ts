// Control UI chat module implements stream reconciliation behavior.
import { asNullableRecord as asToolRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import {
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  trimAccumulatedStreamPrefix,
} from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../lib/string-coerce.ts";
import { resetToolStream } from "./tool-stream.ts";

type StreamReconciliationState = {
  chatStream: string | null;
  chatStreamStartedAt: number | null;
};

type ToolStreamHost = StreamReconciliationState & {
  chatStreamSegments?: Array<{
    text?: unknown;
    ts?: unknown;
    toolCallId?: unknown;
    itemId?: unknown;
  }>;
  chatToolMessages?: unknown[];
  toolStreamById?: Map<string, unknown>;
  toolStreamOrder?: unknown[];
};

type VisibleAssistantStreamPart = {
  text: string;
  replacementText: string;
  source: "segment" | "current";
  timestamp: number;
  itemId?: string;
  toolCallId?: string;
};

type ToolMessageRef = {
  id: string;
};

const TOOL_NAME_FIELDS = ["toolName", "tool_name"] as const;

function addToolRef(refs: ToolMessageRef[], seen: Set<string>, id: string | undefined) {
  if (!id || seen.has(id)) {
    return;
  }
  seen.add(id);
  refs.push({ id });
}

function isToolLikeRole(role: unknown): boolean {
  return typeof role === "string" && normalizeRoleForGrouping(role).toLowerCase() === "tool";
}

function hasToolName(message: Record<string, unknown>): boolean {
  return TOOL_NAME_FIELDS.some((field) => Boolean(normalizeOptionalString(message[field])));
}

function toolContentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.filter(
        (block): block is Record<string, unknown> => Boolean(block) && typeof block === "object",
      )
    : [];
}

function isToolContentBlock(block: Record<string, unknown>): boolean {
  return isToolCallContentType(block.type) || isToolResultContentType(block.type);
}

function extractToolMessageRefs(message: unknown): ToolMessageRef[] {
  const record = asToolRecord(message);
  if (!record) {
    return [];
  }

  const refs: ToolMessageRef[] = [];
  const seen = new Set<string>();
  const blocks = toolContentBlocks(record);
  const topLevelToolId = resolveToolUseId(record);
  const messageHasToolShape =
    isToolLikeRole(record.role) || hasToolName(record) || blocks.some(isToolContentBlock);

  if (messageHasToolShape) {
    addToolRef(refs, seen, topLevelToolId);
  }

  for (const block of blocks) {
    if (!isToolContentBlock(block)) {
      continue;
    }
    addToolRef(refs, seen, resolveToolUseId(block) ?? topLevelToolId);
  }

  return refs;
}

type AssistantMessageVisibility = (message: unknown) => boolean;
type StreamVisibility = (stream: string) => boolean;

type MaterializeVisibleStreamOptions = {
  includeCurrent?: boolean;
  requirePersistedTool?: boolean;
  replacementMessages?: unknown[];
  persistCommentary?: boolean;
  keyedStartIndex?: number;
  isHiddenAssistantMessage: AssistantMessageVisibility;
  isHiddenStreamText: StreamVisibility;
};

export function currentLiveToolCallIds(state: StreamReconciliationState): string[] {
  const toolHost = state as ToolStreamHost;
  return Array.isArray(toolHost.toolStreamOrder)
    ? toolHost.toolStreamOrder.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
}

function lastUserMessageIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
    if (role === "user") {
      return index;
    }
  }
  return -1;
}

export function streamReconciliationStartIndex(
  messages: unknown[],
  beforeIndex = messages.length,
): number {
  return lastUserMessageIndex(messages.slice(0, beforeIndex)) + 1;
}

export function maybeResetToolStream(
  state: StreamReconciliationState,
  opts?: { preserveStreamSegments?: boolean },
) {
  const toolHost = state as ToolStreamHost & Partial<Parameters<typeof resetToolStream>[0]>;
  if (
    toolHost.toolStreamById instanceof Map &&
    Array.isArray(toolHost.toolStreamOrder) &&
    Array.isArray(toolHost.chatToolMessages) &&
    Array.isArray(toolHost.chatStreamSegments)
  ) {
    const preservedStreamSegments = opts?.preserveStreamSegments
      ? [...toolHost.chatStreamSegments]
      : null;
    resetToolStream(toolHost as Parameters<typeof resetToolStream>[0]);
    if (preservedStreamSegments) {
      toolHost.chatStreamSegments = preservedStreamSegments;
    }
  }
}

export function clearToolStreamSegments(state: StreamReconciliationState) {
  const toolHost = state as ToolStreamHost;
  if (Array.isArray(toolHost.chatStreamSegments)) {
    toolHost.chatStreamSegments = [];
  }
}

export function persistedCurrentToolStreamIds(
  messages: unknown[],
  state: StreamReconciliationState,
): Set<string> {
  const liveToolIds = currentLiveToolCallIds(state);
  const matchedToolIds = new Set<string>();
  if (liveToolIds.length === 0) {
    return matchedToolIds;
  }
  const liveToolIdSet = new Set(liveToolIds);
  const persistedToolIds = new Set<string>();
  for (const message of messages.slice(lastUserMessageIndex(messages) + 1)) {
    for (const ref of extractToolMessageRefs(message)) {
      persistedToolIds.add(ref.id);
    }
  }
  for (const id of persistedToolIds) {
    if (liveToolIdSet.has(id)) {
      matchedToolIds.add(id);
    }
  }
  return matchedToolIds;
}

function buildAssistantStreamMessage(
  stream: string,
  replacementText = stream,
  timestamp = Date.now(),
  source: VisibleAssistantStreamPart["source"] = "current",
  itemId?: string,
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: stream }],
    timestamp,
    openclawStreamFallback: {
      replacementText,
      source,
      ...(itemId ? { itemId } : {}),
    },
  };
}

function streamFallbackReplacementText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const fallback = (message as { openclawStreamFallback?: unknown }).openclawStreamFallback;
  if (!fallback || typeof fallback !== "object") {
    return null;
  }
  const replacementText = (fallback as { replacementText?: unknown }).replacementText;
  if (typeof replacementText === "string" && replacementText.trim()) {
    return replacementText.trim();
  }
  return extractText(message)?.trim() ?? null;
}

function terminalMessageReplacesStreamFallback(message: unknown, fallback: unknown): boolean {
  const fallbackText = streamFallbackReplacementText(fallback);
  if (!fallbackText) {
    return false;
  }
  const metadata = (fallback as { openclawStreamFallback?: unknown }).openclawStreamFallback;
  const source =
    metadata && typeof metadata === "object"
      ? (metadata as { source?: unknown }).source
      : undefined;
  const itemId =
    metadata && typeof metadata === "object"
      ? (metadata as { itemId?: unknown }).itemId
      : undefined;
  if (source === "segment" && typeof itemId === "string" && itemId.trim()) {
    return false;
  }
  const terminalText = extractText(message)?.trim();
  return Boolean(
    terminalText && (terminalText === fallbackText || terminalText.startsWith(fallbackText)),
  );
}

export function appendTerminalAssistantMessage(messages: unknown[], message: unknown): unknown[] {
  const retainedMessages = messages.filter((existing, index) => {
    if (index <= lastUserMessageIndex(messages)) {
      return true;
    }
    return !terminalMessageReplacesStreamFallback(message, existing);
  });
  return [...retainedMessages, message];
}

function visibleAssistantStreamText(
  stream: string | null,
  isHiddenStreamText: StreamVisibility,
): string | null {
  if (!stream?.trim() || isHiddenStreamText(stream)) {
    return null;
  }
  return stream;
}

function hasAssistantStreamReplacement(
  messages: unknown[],
  stream: string,
  isHiddenAssistantMessage: AssistantMessageVisibility,
  startIndex: number,
): boolean {
  const expected = stream.trim();
  if (!expected) {
    return false;
  }
  return messages.slice(startIndex).some((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
    if (role && role !== "assistant") {
      return false;
    }
    if (role === "assistant" && isHiddenAssistantMessage(message)) {
      return false;
    }
    const text = extractText(message)?.trim();
    return Boolean(text && (text === expected || text.startsWith(expected)));
  });
}

function streamFallbackItemId(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const fallback = (message as { openclawStreamFallback?: unknown }).openclawStreamFallback;
  if (!fallback || typeof fallback !== "object") {
    return null;
  }
  const itemId = (fallback as { itemId?: unknown }).itemId;
  return typeof itemId === "string" && itemId.trim() ? itemId.trim() : null;
}

function hasKeyedAssistantStreamReplacement(
  messages: unknown[],
  itemId: string,
  startIndex: number,
): boolean {
  return messages.slice(startIndex).some((message) => streamFallbackItemId(message) === itemId);
}

function visibleAssistantStreamParts(
  state: StreamReconciliationState,
  opts: Pick<MaterializeVisibleStreamOptions, "includeCurrent" | "isHiddenStreamText">,
): VisibleAssistantStreamPart[] {
  const streamHost = state as ToolStreamHost;
  const liveToolIds = currentLiveToolCallIds(state);
  const parts: VisibleAssistantStreamPart[] = [];
  let previousText: string | null = null;
  const segments = Array.isArray(streamHost.chatStreamSegments)
    ? streamHost.chatStreamSegments
    : [];
  let toolIndexedSegmentIndex = 0;
  for (const segment of segments) {
    if (!segment || typeof segment.text !== "string") {
      continue;
    }
    const explicitToolCallId =
      typeof segment.toolCallId === "string" && segment.toolCallId.trim()
        ? segment.toolCallId.trim()
        : null;
    const usesItemId = streamSegmentHasItemId(segment);
    const itemId =
      usesItemId && typeof segment.itemId === "string" ? segment.itemId.trim() : undefined;
    const indexedToolCallId = usesItemId ? undefined : liveToolIds[toolIndexedSegmentIndex];
    if (!usesItemId) {
      toolIndexedSegmentIndex += 1;
    }
    const usesAccumulatedText = streamSegmentUsesAccumulatedText(segment);
    const visible = visibleAssistantStreamText(
      usesAccumulatedText ? trimAccumulatedStreamPrefix(segment.text, previousText) : segment.text,
      opts.isHiddenStreamText,
    );
    if (visible) {
      parts.push({
        text: visible,
        replacementText: segment.text,
        source: "segment",
        timestamp:
          typeof segment.ts === "number" && Number.isFinite(segment.ts) ? segment.ts : Date.now(),
        ...(itemId ? { itemId } : {}),
        toolCallId: explicitToolCallId ?? indexedToolCallId,
      });
    }
    if (usesAccumulatedText && segment.text.trim()) {
      previousText = segment.text;
    }
  }
  if (opts.includeCurrent !== false && typeof state.chatStream === "string") {
    const visible = visibleAssistantStreamText(
      trimAccumulatedStreamPrefix(state.chatStream, previousText),
      opts.isHiddenStreamText,
    );
    if (visible) {
      parts.push({
        text: visible,
        replacementText: state.chatStream,
        source: "current",
        timestamp: state.chatStreamStartedAt ?? Date.now(),
      });
    }
  }
  return parts;
}

export function visibleCurrentAssistantStreamTail(
  state: StreamReconciliationState,
  isHiddenStreamText: StreamVisibility,
): string | null {
  if (typeof state.chatStream !== "string") {
    return null;
  }
  const streamHost = state as ToolStreamHost;
  const segments = Array.isArray(streamHost.chatStreamSegments)
    ? streamHost.chatStreamSegments
    : [];
  let previousText: string | null = null;
  for (const segment of segments) {
    if (
      streamSegmentUsesAccumulatedText(segment) &&
      typeof segment.text === "string" &&
      segment.text.trim()
    ) {
      previousText = segment.text;
    }
  }
  return visibleAssistantStreamText(
    trimAccumulatedStreamPrefix(state.chatStream, previousText),
    isHiddenStreamText,
  );
}

function hasAssistantStreamPartReplacement(
  messages: unknown[],
  part: VisibleAssistantStreamPart,
  isHiddenAssistantMessage: AssistantMessageVisibility,
  startIndex: number,
): boolean {
  if (part.itemId) {
    return hasKeyedAssistantStreamReplacement(messages, part.itemId, startIndex);
  }
  return (
    hasAssistantStreamReplacement(
      messages,
      part.replacementText,
      isHiddenAssistantMessage,
      startIndex,
    ) || hasAssistantStreamReplacement(messages, part.text, isHiddenAssistantMessage, startIndex)
  );
}

function hasVisibleAssistantMessageAfterUser(
  messages: unknown[],
  isHiddenAssistantMessage: AssistantMessageVisibility,
): boolean {
  const startIndex = lastUserMessageIndex(messages) + 1;
  return messages.slice(startIndex).some((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
    if (role !== "assistant" || isHiddenAssistantMessage(message)) {
      return false;
    }
    return Boolean(extractText(message)?.trim());
  });
}

export function historyReplacedVisibleStream(
  messages: unknown[],
  state: StreamReconciliationState,
  opts: Pick<
    MaterializeVisibleStreamOptions,
    "includeCurrent" | "isHiddenAssistantMessage" | "isHiddenStreamText" | "persistCommentary"
  >,
): boolean {
  const parts = visibleAssistantStreamParts(state, opts);
  const requiredParts =
    opts.persistCommentary === true ? parts : parts.filter((part) => !part.itemId);
  return (
    parts.length > 0 &&
    (requiredParts.length > 0 ||
      hasVisibleAssistantMessageAfterUser(messages, opts.isHiddenAssistantMessage)) &&
    requiredParts.every((part) =>
      hasAssistantStreamPartReplacement(
        messages,
        part,
        opts.isHiddenAssistantMessage,
        streamReconciliationStartIndex(messages),
      ),
    )
  );
}

export function hasVisibleStreamParts(
  state: StreamReconciliationState,
  opts: Pick<MaterializeVisibleStreamOptions, "includeCurrent" | "isHiddenStreamText">,
): boolean {
  return visibleAssistantStreamParts(state, opts).length > 0;
}

export function terminalMessageReplacesVisibleStream(
  message: unknown,
  state: StreamReconciliationState,
  opts: Pick<MaterializeVisibleStreamOptions, "isHiddenStreamText" | "persistCommentary">,
): boolean {
  const terminalText = extractText(message)?.trim();
  if (!terminalText) {
    return false;
  }
  const parts = visibleAssistantStreamParts(state, {
    includeCurrent: true,
    isHiddenStreamText: opts.isHiddenStreamText,
  }).filter((part) => opts.persistCommentary === true || !part.itemId);
  if (parts.length === 0) {
    return false;
  }

  let searchStart = 0;
  for (const [index, part] of parts.entries()) {
    const text = part.text.trim();
    const matchIndex = terminalText.indexOf(text, searchStart);
    // A terminal replacement must preserve the complete visible stream in order,
    // beginning with its first part. Otherwise both outputs are user-visible.
    if (matchIndex < 0 || (index === 0 && matchIndex !== 0)) {
      return false;
    }
    searchStart = matchIndex + text.length;
  }
  return true;
}

function currentToolStreamMessageIndex(
  messages: unknown[],
  state: StreamReconciliationState,
  startIndex: number,
  toolCallId?: string,
): number {
  const liveToolIds = toolCallId ? new Set([toolCallId]) : new Set(currentLiveToolCallIds(state));
  if (liveToolIds.size === 0) {
    return -1;
  }
  for (let index = startIndex; index < messages.length; index++) {
    if (extractToolMessageRefs(messages[index]).some((ref) => liveToolIds.has(ref.id))) {
      return index;
    }
  }
  return -1;
}

function insertMessageAtIndex(messages: unknown[], message: unknown, index: number): unknown[] {
  return [...messages.slice(0, index), message, ...messages.slice(index)];
}

function timestampOrderedInsertIndex(
  messages: unknown[],
  desiredTimestamp: number,
  startIndex: number,
): number {
  for (let index = startIndex; index < messages.length; index++) {
    const timestamp = messageTimestampMs(messages[index]);
    if (timestamp != null && timestamp > desiredTimestamp) {
      return index;
    }
  }
  return messages.length;
}

export function messageTimestampMs(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const timestamp = (message as { timestamp?: unknown; ts?: unknown }).timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  const ts = (message as { timestamp?: unknown; ts?: unknown }).ts;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

function timestampForInsertedVisibleStream(
  messages: unknown[],
  index: number,
  desiredTimestamp: number,
): number {
  const previousTimestamp = messages
    .slice(0, index)
    .toReversed()
    .map(messageTimestampMs)
    .find((timestamp): timestamp is number => timestamp != null);
  const nextTimestamp = messages
    .slice(index)
    .map(messageTimestampMs)
    .find((timestamp): timestamp is number => timestamp != null);
  if (previousTimestamp != null && desiredTimestamp <= previousTimestamp) {
    const afterPrevious = previousTimestamp + 1;
    return nextTimestamp != null && afterPrevious >= nextTimestamp
      ? previousTimestamp + (nextTimestamp - previousTimestamp) / 2
      : afterPrevious;
  }
  if (nextTimestamp != null && desiredTimestamp >= nextTimestamp) {
    const beforeNext = nextTimestamp - 1;
    return previousTimestamp != null && beforeNext <= previousTimestamp
      ? previousTimestamp + (nextTimestamp - previousTimestamp) / 2
      : beforeNext;
  }
  return desiredTimestamp;
}

export function materializeVisibleStreamState(
  messages: unknown[],
  state: StreamReconciliationState,
  opts: MaterializeVisibleStreamOptions,
): unknown[] {
  let nextMessages = messages;
  const persistCommentary = opts.persistCommentary === true;
  for (const part of visibleAssistantStreamParts(state, opts)) {
    if (!persistCommentary && part.itemId) {
      continue;
    }
    const replacementMessages = opts.replacementMessages ?? [];
    const defaultStartIndex = streamReconciliationStartIndex(nextMessages);
    const startIndex = part.itemId
      ? (opts.keyedStartIndex ?? defaultStartIndex)
      : defaultStartIndex;
    if (
      hasAssistantStreamPartReplacement(
        [...nextMessages, ...replacementMessages],
        part,
        opts.isHiddenAssistantMessage,
        startIndex,
      )
    ) {
      continue;
    }
    const toolIndex =
      part.source === "segment" && part.toolCallId
        ? currentToolStreamMessageIndex(nextMessages, state, startIndex, part.toolCallId)
        : -1;
    if (opts.requirePersistedTool && toolIndex < 0) {
      continue;
    }
    const insertIndex =
      toolIndex >= 0
        ? toolIndex
        : part.source === "segment"
          ? timestampOrderedInsertIndex(nextMessages, part.timestamp, startIndex)
          : nextMessages.length;
    const streamMessage = buildAssistantStreamMessage(
      part.text,
      part.replacementText,
      timestampForInsertedVisibleStream(nextMessages, insertIndex, part.timestamp),
      part.source,
      part.itemId,
    );
    nextMessages = insertMessageAtIndex(nextMessages, streamMessage, insertIndex);
  }
  return nextMessages;
}

export function prunePersistedToolStreamMessages(
  state: StreamReconciliationState,
  persistedToolIds: Set<string>,
) {
  if (persistedToolIds.size === 0) {
    return;
  }
  const toolHost = state as ToolStreamHost;
  const liveToolIds = currentLiveToolCallIds(state);
  if (toolHost.toolStreamById instanceof Map) {
    for (const id of persistedToolIds) {
      toolHost.toolStreamById.delete(id);
    }
  }
  if (Array.isArray(toolHost.toolStreamOrder)) {
    toolHost.toolStreamOrder = toolHost.toolStreamOrder.filter(
      (id): id is string => typeof id === "string" && !persistedToolIds.has(id),
    );
  }
  if (Array.isArray(toolHost.chatToolMessages)) {
    toolHost.chatToolMessages = toolHost.chatToolMessages.filter((message) => {
      const refs = extractToolMessageRefs(message);
      return refs.every((ref) => !persistedToolIds.has(ref.id));
    });
  }
  if (!Array.isArray(toolHost.chatStreamSegments)) {
    return;
  }
  let lastPrunedAccumulatedText: string | null = null;
  let toolIndexedSegmentIndex = 0;
  toolHost.chatStreamSegments = toolHost.chatStreamSegments.flatMap((segment) => {
    const explicitToolCallId =
      typeof segment.toolCallId === "string" && segment.toolCallId.trim()
        ? segment.toolCallId.trim()
        : null;
    const usesItemId = streamSegmentHasItemId(segment);
    const indexedToolCallId = usesItemId ? null : (liveToolIds[toolIndexedSegmentIndex] ?? null);
    if (!usesItemId) {
      toolIndexedSegmentIndex += 1;
    }
    const toolCallId = explicitToolCallId ?? indexedToolCallId;
    const text = typeof segment.text === "string" ? segment.text : "";
    if (toolCallId && persistedToolIds.has(toolCallId)) {
      if (streamSegmentUsesAccumulatedText(segment) && text.trim()) {
        lastPrunedAccumulatedText = text;
      }
      return [];
    }
    const nextText =
      lastPrunedAccumulatedText && streamSegmentUsesAccumulatedText(segment)
        ? trimAccumulatedStreamPrefix(text, lastPrunedAccumulatedText)
        : text;
    return [{ ...segment, text: nextText }];
  });
}
