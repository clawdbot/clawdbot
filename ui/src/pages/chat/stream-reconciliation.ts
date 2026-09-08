import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  trimAccumulatedStreamPrefix,
} from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isKeyedAssistantStreamFallbackMessage } from "./chat-thread-run-identity.ts";
import {
  resolveAssistantTextTail,
  streamCausalInsertIndex,
  streamCausalInterval,
  streamCausalTimestamp,
  type StreamCausalBoundaryState,
} from "./stream-causal-boundary.ts";
import {
  readLiveTerminalAfterBoundaryRunId,
  readLiveTerminalRunId,
} from "./terminal-message-identity.ts";
import {
  extractToolMessageRefs,
  resolveLiveToolStreamRefs,
  resolveMatchingLiveToolIdentity,
} from "./tool-stream-identity.ts";
import { resetToolStream, resetToolStreamRun } from "./tool-stream-state.ts";

type StreamReconciliationState = StreamCausalBoundaryState & {
  chatStream: string | null;
  chatStreamStartedAt: number | null;
};

type ToolStreamHost = StreamReconciliationState & {
  chatToolMessages?: unknown[];
  toolStreamById?: Map<string, unknown>;
  toolStreamOrder?: unknown[];
};

type VisibleAssistantStreamPart = {
  text: string;
  replacementText: string;
  source: "segment" | "current";
  timestamp: number;
  segmentIndex?: number;
  itemId?: string;
  runId?: string;
  afterBoundaryRunId?: string;
  boundaryRunId?: string;
  toolCallId?: string;
};

type AssistantMessageVisibility = (message: unknown) => boolean;
type StreamVisibility = (stream: string) => boolean;
type MaterializeVisibleStreamOptions = {
  includeCurrent?: boolean;
  requirePersistedTool?: boolean;
  replacementMessages?: unknown[];
  persistCommentary?: boolean;
  isHiddenAssistantMessage: AssistantMessageVisibility;
  isHiddenStreamText: StreamVisibility;
};

function resettableToolStreamHost(
  state: StreamReconciliationState,
): Parameters<typeof resetToolStream>[0] | null {
  const toolHost = state as ToolStreamHost & Partial<Parameters<typeof resetToolStream>[0]>;
  return toolHost.toolStreamById instanceof Map &&
    Array.isArray(toolHost.toolStreamOrder) &&
    Array.isArray(toolHost.chatToolMessages) &&
    Array.isArray(toolHost.chatStreamSegments)
    ? (toolHost as Parameters<typeof resetToolStream>[0])
    : null;
}

export function currentLiveToolCallIds(state: StreamReconciliationState): string[] {
  const toolHost = state as ToolStreamHost;
  return Array.isArray(toolHost.toolStreamOrder)
    ? toolHost.toolStreamOrder.filter((v): v is string => normalizeOptionalString(v) !== undefined)
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

export function maybeResetToolStream(
  state: StreamReconciliationState,
  opts?: { preserveStreamSegments?: boolean },
) {
  const toolHost = resettableToolStreamHost(state);
  if (!toolHost) {
    return;
  }
  const preservedStreamSegments = opts?.preserveStreamSegments
    ? [...toolHost.chatStreamSegments]
    : null;
  resetToolStream(toolHost);
  if (preservedStreamSegments) {
    toolHost.chatStreamSegments = preservedStreamSegments;
  }
}

export function maybeResetToolStreamRun(state: StreamReconciliationState, runId: string) {
  const toolHost = resettableToolStreamHost(state);
  if (toolHost) {
    resetToolStreamRun(toolHost, runId);
  }
}

export function clearToolStreamSegments(state: StreamReconciliationState) {
  const toolHost = state as ToolStreamHost;
  if (Array.isArray(toolHost.chatStreamSegments)) {
    toolHost.chatStreamSegments = [];
  }
}

function buildAssistantStreamMessage(
  stream: string,
  replacementText = stream,
  timestamp = Date.now(),
  source: VisibleAssistantStreamPart["source"] = "current",
  itemId?: string,
  runId?: string,
  afterBoundaryRunId?: string,
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: stream }],
    timestamp,
    openclawStreamFallback: {
      replacementText,
      source,
      ...(itemId ? { itemId } : {}),
      ...(runId ? { runId } : {}),
      ...(afterBoundaryRunId ? { afterBoundaryRunId } : {}),
    },
  };
}

function streamFallbackMetadata(message: unknown): Record<string, unknown> | null {
  const metadata = asNullableRecord(asNullableRecord(message)?.openclawStreamFallback);
  return metadata;
}

function unkeyedStreamFallbackMetadata(message: unknown): Record<string, unknown> | null {
  const metadata = streamFallbackMetadata(message);
  return metadata && !normalizeOptionalString(metadata.itemId) ? metadata : null;
}

export function appendTerminalAssistantMessage(
  messages: unknown[],
  message: unknown,
  opts?: { preserveKeyedCommentary?: boolean },
): unknown[] {
  const identity = readSessionMessageIdentity(message);
  const terminalRunId =
    (identity?.role === "assistant" ? identity.runId : null) ?? readLiveTerminalRunId(message);
  let afterBoundaryRunId = readLiveTerminalAfterBoundaryRunId(message) ?? undefined;
  if (terminalRunId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const existing = messages[index];
      const fallback = unkeyedStreamFallbackMetadata(existing);
      if (!fallback || normalizeOptionalString(fallback.runId) !== terminalRunId) {
        continue;
      }
      afterBoundaryRunId =
        normalizeOptionalString(fallback.afterBoundaryRunId) ?? afterBoundaryRunId;
      break;
    }
  }
  const interval = streamCausalInterval(messages, {
    ...(terminalRunId ? { runId: terminalRunId } : {}),
    ...(afterBoundaryRunId ? { afterBoundaryRunId } : {}),
  });
  const terminalText = extractText(message)?.trim() ?? "";
  const removedIndexes = new Set<number>();
  const currentFallbackIndexes: number[] = [];
  let terminalCursor = 0;
  for (let index = interval.start; index < interval.end; index += 1) {
    const existing = messages[index];
    const fallback = streamFallbackMetadata(existing);
    if (!fallback) {
      continue;
    }
    const visibleText = extractText(existing)?.trim();
    if (normalizeOptionalString(fallback.itemId)) {
      // Keyed stream segments normally represent commentary and must remain
      // beside the final answer. When a keyed segment is the exact final
      // answer, though, retaining both renders the streamed and persisted
      // copies as duplicate assistant messages.
      if (!opts?.preserveKeyedCommentary && visibleText && visibleText === terminalText) {
        removedIndexes.add(index);
      }
      continue;
    }
    if (fallback.source === "current") {
      currentFallbackIndexes.push(index);
    }
    if (!visibleText) {
      continue;
    }
    const remainingTerminal = terminalText.slice(terminalCursor);
    const leadingWhitespace = /^\s*/u.exec(remainingTerminal)?.[0].length ?? 0;
    if (!remainingTerminal.slice(leadingWhitespace).startsWith(visibleText)) {
      continue;
    }
    removedIndexes.add(index);
    terminalCursor += leadingWhitespace + visibleText.length;
  }
  const onlyCurrentFallbackIndex = currentFallbackIndexes[0];
  if (
    removedIndexes.size === 0 &&
    currentFallbackIndexes.length === 1 &&
    onlyCurrentFallbackIndex !== undefined
  ) {
    removedIndexes.add(onlyCurrentFallbackIndex);
  }
  const retainedInterval: unknown[] = [];
  let insertIndex: number | null = null;
  for (let index = interval.start; index < interval.end; index += 1) {
    if (removedIndexes.has(index)) {
      insertIndex ??= retainedInterval.length;
    } else {
      retainedInterval.push(messages[index]);
    }
  }
  const targetIndex = insertIndex ?? retainedInterval.length;
  return [
    ...messages.slice(0, interval.start),
    ...retainedInterval.slice(0, targetIndex),
    message,
    ...retainedInterval.slice(targetIndex),
    ...messages.slice(interval.end),
  ];
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

export function visibleAssistantStreamParts(
  state: StreamReconciliationState,
  opts: Pick<MaterializeVisibleStreamOptions, "includeCurrent" | "isHiddenStreamText">,
): VisibleAssistantStreamPart[] {
  const streamHost = state as ToolStreamHost;
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  const parts: VisibleAssistantStreamPart[] = [];
  let previousText: string | null = null;
  const segments = Array.isArray(streamHost.chatStreamSegments)
    ? streamHost.chatStreamSegments
    : [];
  let toolIndexedSegmentIndex = 0;
  let latestBoundaryRunId: string | undefined;
  for (const [segmentIndex, segment] of segments.entries()) {
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
    const indexedToolRef = usesItemId ? undefined : liveToolRefs[toolIndexedSegmentIndex];
    const segmentRunId = normalizeOptionalString(segment.runId) ?? indexedToolRef?.runId;
    const afterBoundaryRunId =
      normalizeOptionalString(segment.afterBoundaryRunId) ?? latestBoundaryRunId;
    const boundaryRunId = normalizeOptionalString(segment.boundaryRunId);
    if (!usesItemId && segment.boundaryMarker !== true && segment.persisted !== true) {
      toolIndexedSegmentIndex += 1;
    }
    const usesAccumulatedText = streamSegmentUsesAccumulatedText(segment);
    const visible = visibleAssistantStreamText(
      usesAccumulatedText ? trimAccumulatedStreamPrefix(segment.text, previousText) : segment.text,
      opts.isHiddenStreamText,
    );
    if (visible && segment.persisted !== true) {
      parts.push({
        text: visible,
        replacementText: segment.text,
        source: "segment",
        segmentIndex,
        timestamp:
          typeof segment.ts === "number" && Number.isFinite(segment.ts) ? segment.ts : Date.now(),
        ...(itemId ? { itemId } : {}),
        ...(segmentRunId ? { runId: segmentRunId } : {}),
        ...(afterBoundaryRunId ? { afterBoundaryRunId } : {}),
        ...(boundaryRunId ? { boundaryRunId } : {}),
        toolCallId: explicitToolCallId ?? indexedToolRef?.id,
      });
    }
    if (usesAccumulatedText) {
      previousText = advanceAccumulatedStreamText(previousText, segment.text);
    }
    if (boundaryRunId) {
      latestBoundaryRunId = boundaryRunId;
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
        ...(state.chatRunId ? { runId: state.chatRunId } : {}),
        ...(latestBoundaryRunId ? { afterBoundaryRunId: latestBoundaryRunId } : {}),
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
  const previousText = accumulatedStreamText(segments);
  return visibleAssistantStreamText(
    trimAccumulatedStreamPrefix(state.chatStream, previousText),
    isHiddenStreamText,
  );
}

export function hasAssistantStreamPartReplacement(
  messages: unknown[],
  part: VisibleAssistantStreamPart,
  isHiddenAssistantMessage: AssistantMessageVisibility,
  startIndex: number,
  endIndex = messages.length,
): boolean {
  if (part.itemId) {
    return messages.slice(startIndex, endIndex).some((message) => {
      const identity = readAssistantStreamSegmentIdentity(message);
      // Native commentary can lack run metadata; the caller's causal interval
      // still bounds that item, but known opposing runs must never replace it.
      return (
        identity !== undefined &&
        identity.itemId === part.itemId &&
        (!identity.runId || !part.runId || identity.runId === part.runId)
      );
    });
  }
  const persistedTexts = messages.slice(startIndex, endIndex).map((message) => {
    const identity = readSessionMessageIdentity(message);
    if (
      (identity?.role && identity.role !== "assistant") ||
      (identity?.runId && part.runId && identity.runId !== part.runId) ||
      isHiddenAssistantMessage(message) ||
      isKeyedAssistantStreamFallbackMessage(message)
    ) {
      return null;
    }
    return extractText(message)?.trim() ?? null;
  });
  return [part.replacementText, part.text].some(
    (text) => Boolean(text.trim()) && !resolveAssistantTextTail(persistedTexts, text.trim()),
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
    requiredParts.every((part) => {
      const interval = streamCausalInterval(messages, part);
      return hasAssistantStreamPartReplacement(
        messages,
        part,
        opts.isHiddenAssistantMessage,
        interval.start,
        interval.end,
      );
    })
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
  endIndex: number,
  toolCallId?: string,
  runId?: string,
): number {
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  const selectedToolIdentity = toolCallId
    ? resolveMatchingLiveToolIdentity({ id: toolCallId, ...(runId ? { runId } : {}) }, liveToolRefs)
    : undefined;
  const liveToolIds = selectedToolIdentity
    ? new Set([selectedToolIdentity])
    : toolCallId
      ? new Set<string>()
      : new Set(liveToolRefs.map((ref) => ref.identity));
  if (liveToolIds.size === 0) {
    return -1;
  }
  for (let index = startIndex; index < endIndex; index++) {
    if (
      extractToolMessageRefs(messages[index]).some((ref) => {
        const identity = resolveMatchingLiveToolIdentity(ref, liveToolRefs);
        return identity !== undefined && liveToolIds.has(identity);
      })
    ) {
      return index;
    }
  }
  return -1;
}

function messageTimestampMs(message: unknown): number | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as { timestamp?: unknown; ts?: unknown };
  return asFiniteNumber(record.timestamp) ?? asFiniteNumber(record.ts) ?? null;
}

export function materializeVisibleStreamState(
  messages: unknown[],
  state: StreamReconciliationState,
  opts: MaterializeVisibleStreamOptions,
): unknown[] {
  let nextMessages = messages;
  const persistCommentary = opts.persistCommentary === true;
  const replacementMessages = opts.replacementMessages;
  for (const part of visibleAssistantStreamParts(state, opts)) {
    if (!persistCommentary && part.itemId) {
      continue;
    }
    const replacementCandidates = replacementMessages?.length
      ? [...nextMessages, ...replacementMessages]
      : nextMessages;
    const replacementInterval = streamCausalInterval(replacementCandidates, part);
    if (
      hasAssistantStreamPartReplacement(
        replacementCandidates,
        part,
        opts.isHiddenAssistantMessage,
        replacementInterval.start,
        replacementInterval.end,
      )
    ) {
      continue;
    }
    const interval =
      replacementCandidates === nextMessages
        ? replacementInterval
        : streamCausalInterval(nextMessages, part);
    const toolIndex =
      part.source === "segment" && part.toolCallId
        ? currentToolStreamMessageIndex(
            nextMessages,
            state,
            interval.start,
            interval.end,
            part.toolCallId,
            part.runId,
          )
        : -1;
    if (opts.requirePersistedTool && toolIndex < 0) {
      continue;
    }
    const insertIndex =
      toolIndex >= 0
        ? toolIndex
        : part.source === "segment"
          ? streamCausalInsertIndex(
              nextMessages,
              part.timestamp,
              interval.start,
              interval.end,
              messageTimestampMs,
            )
          : interval.end;
    const streamMessage = buildAssistantStreamMessage(
      part.text,
      part.replacementText,
      streamCausalTimestamp(nextMessages, insertIndex, part.timestamp, messageTimestampMs),
      part.source,
      part.itemId,
      part.runId,
      part.afterBoundaryRunId,
    );
    nextMessages = [
      ...nextMessages.slice(0, insertIndex),
      streamMessage,
      ...nextMessages.slice(insertIndex),
    ];
  }
  return nextMessages;
}
