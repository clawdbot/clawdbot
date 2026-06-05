// Control UI chat module implements stream reconciliation behavior.
import { resetToolStream } from "../app-tool-stream.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import { extractText } from "./message-extract.ts";
import { trimAccumulatedStreamPrefix } from "./stream-text.ts";
import { extractToolMessageRefs } from "./tool-message-refs.ts";

export type StreamReconciliationState = {
  chatStream: string | null;
  chatStreamStartedAt: number | null;
};

type ToolStreamHost = StreamReconciliationState & {
  chatStreamSegments?: Array<{ text?: unknown; ts?: unknown; toolCallId?: unknown }>;
  chatToolMessages?: unknown[];
  toolStreamById?: Map<string, unknown>;
  toolStreamOrder?: unknown[];
};

type VisibleAssistantStreamPart = {
  text: string;
  replacementText: string;
  source: "segment" | "current";
  timestamp: number;
  toolCallId?: string;
};

export type AssistantMessageVisibility = (message: unknown) => boolean;
export type StreamVisibility = (stream: string) => boolean;

export type MaterializeVisibleStreamOptions = {
  includeCurrent?: boolean;
  requirePersistedTool?: boolean;
  replacementMessages?: unknown[];
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

export function lastUserMessageIndex(messages: unknown[]): number {
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
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: stream }],
    timestamp,
    openclawStreamFallback: {
      replacementText,
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
): boolean {
  const expected = stream.trim();
  if (!expected) {
    return false;
  }
  const startIndex = lastUserMessageIndex(messages) + 1;
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
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    if (!segment || typeof segment.text !== "string") {
      continue;
    }
    const visible = visibleAssistantStreamText(
      trimAccumulatedStreamPrefix(segment.text, previousText),
      opts.isHiddenStreamText,
    );
    if (visible) {
      parts.push({
        text: visible,
        replacementText: segment.text,
        source: "segment",
        timestamp:
          typeof segment.ts === "number" && Number.isFinite(segment.ts) ? segment.ts : Date.now(),
        toolCallId:
          typeof segment.toolCallId === "string" && segment.toolCallId.trim()
            ? segment.toolCallId.trim()
            : liveToolIds[segmentIndex],
      });
    }
    if (segment.text.trim()) {
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
    if (typeof segment.text === "string" && segment.text.trim()) {
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
): boolean {
  return (
    hasAssistantStreamReplacement(messages, part.replacementText, isHiddenAssistantMessage) ||
    hasAssistantStreamReplacement(messages, part.text, isHiddenAssistantMessage)
  );
}

export function historyReplacedVisibleStream(
  messages: unknown[],
  state: StreamReconciliationState,
  opts: Pick<
    MaterializeVisibleStreamOptions,
    "includeCurrent" | "isHiddenAssistantMessage" | "isHiddenStreamText"
  >,
): boolean {
  const parts = visibleAssistantStreamParts(state, opts);
  return (
    parts.length > 0 &&
    parts.every((part) =>
      hasAssistantStreamPartReplacement(messages, part, opts.isHiddenAssistantMessage),
    )
  );
}

export function hasVisibleStreamParts(
  state: StreamReconciliationState,
  opts: Pick<MaterializeVisibleStreamOptions, "includeCurrent" | "isHiddenStreamText">,
): boolean {
  return visibleAssistantStreamParts(state, opts).length > 0;
}

function currentToolStreamMessageIndex(
  messages: unknown[],
  state: StreamReconciliationState,
  toolCallId?: string,
): number {
  const liveToolIds = toolCallId ? new Set([toolCallId]) : new Set(currentLiveToolCallIds(state));
  if (liveToolIds.size === 0) {
    return -1;
  }
  const startIndex = lastUserMessageIndex(messages) + 1;
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

function messageTimestampMs(message: unknown): number | null {
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
  for (const part of visibleAssistantStreamParts(state, opts)) {
    const replacementMessages = opts.replacementMessages ?? [];
    if (
      hasAssistantStreamPartReplacement(
        [...nextMessages, ...replacementMessages],
        part,
        opts.isHiddenAssistantMessage,
      )
    ) {
      continue;
    }
    const toolIndex =
      part.source === "segment"
        ? currentToolStreamMessageIndex(nextMessages, state, part.toolCallId)
        : -1;
    if (opts.requirePersistedTool && toolIndex < 0) {
      continue;
    }
    const insertIndex = toolIndex >= 0 ? toolIndex : nextMessages.length;
    const streamMessage = buildAssistantStreamMessage(
      part.text,
      part.replacementText,
      timestampForInsertedVisibleStream(nextMessages, insertIndex, part.timestamp),
    );
    nextMessages =
      toolIndex >= 0
        ? insertMessageAtIndex(nextMessages, streamMessage, toolIndex)
        : [...nextMessages, streamMessage];
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
  toolHost.chatStreamSegments = toolHost.chatStreamSegments.flatMap((segment, index) => {
    const explicitToolCallId =
      typeof segment.toolCallId === "string" && segment.toolCallId.trim()
        ? segment.toolCallId.trim()
        : null;
    const toolCallId = explicitToolCallId ?? liveToolIds[index] ?? null;
    const text = typeof segment.text === "string" ? segment.text : "";
    if (toolCallId && persistedToolIds.has(toolCallId)) {
      if (text.trim()) {
        lastPrunedAccumulatedText = text;
      }
      return [];
    }
    const nextText = lastPrunedAccumulatedText
      ? trimAccumulatedStreamPrefix(text, lastPrunedAccumulatedText)
      : text;
    return [{ ...segment, text: nextText }];
  });
}
