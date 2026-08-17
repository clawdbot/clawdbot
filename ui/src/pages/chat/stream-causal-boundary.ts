import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  advanceAccumulatedStreamText,
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { userTurnSendIdentity } from "./chat-thread-items.ts";

export type StreamCausalBoundaryState = {
  chatMessages?: unknown[];
  chatRunId?: string | null;
  chatStreamSegments?: ChatStreamSegment[];
};

type StreamRolloverState = {
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatStreamSegments?: ChatStreamSegment[];
};

function lastUserMessageIndex(messages: unknown[], beforeIndex = messages.length): number {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (readSessionMessageIdentity(messages[index])?.role === "user") {
      return index;
    }
  }
  return -1;
}

export function persistedSteerTargetRunId(message: unknown): string | null {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  return normalizeOptionalString(metadata?.steerTargetRunId) ?? null;
}

export function latestPersistedSteerBoundary(
  messages: unknown[],
  activeRunId: string,
): { index: number; runId: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (
      readSessionMessageIdentity(messages[index])?.role !== "user" ||
      persistedSteerTargetRunId(messages[index]) !== activeRunId
    ) {
      continue;
    }
    const identity = userTurnSendIdentity(messages[index]);
    if (identity?.startsWith("send:")) {
      return { index, runId: identity.slice("send:".length) };
    }
  }
  return null;
}

export function latestStreamBoundaryRunId(state: StreamCausalBoundaryState): string | undefined {
  const segments = state.chatStreamSegments ?? [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const boundaryRunId = normalizeOptionalString(segments[index]?.boundaryRunId);
    if (boundaryRunId) {
      return boundaryRunId;
    }
  }
  return undefined;
}

export function streamCausalInterval(
  messages: unknown[],
  part: { afterBoundaryRunId?: string; boundaryRunId?: string; runId?: string },
): { start: number; end: number } {
  const afterBoundaryIdentity = part.afterBoundaryRunId ? `send:${part.afterBoundaryRunId}` : null;
  const afterBoundaryIndex = afterBoundaryIdentity
    ? messages.findIndex((message) => userTurnSendIdentity(message) === afterBoundaryIdentity)
    : -1;
  const boundaryIdentity = part.boundaryRunId ? `send:${part.boundaryRunId}` : null;
  const boundaryIndex = boundaryIdentity
    ? messages.findIndex((message) => userTurnSendIdentity(message) === boundaryIdentity)
    : -1;
  if (boundaryIndex >= 0) {
    return {
      start:
        afterBoundaryIndex >= 0
          ? afterBoundaryIndex + 1
          : lastUserMessageIndex(messages, boundaryIndex) + 1,
      end: boundaryIndex,
    };
  }
  if (afterBoundaryIndex >= 0) {
    const end = messages.findIndex(
      (message, index) =>
        index > afterBoundaryIndex && readSessionMessageIdentity(message)?.role === "user",
    );
    return { start: afterBoundaryIndex + 1, end: end >= 0 ? end : messages.length };
  }
  const runIdentity = part.runId ? `send:${part.runId}` : null;
  const runUserIndex = runIdentity
    ? messages.findIndex((message) => userTurnSendIdentity(message) === runIdentity)
    : -1;
  if (runUserIndex >= 0) {
    const end = messages.findIndex(
      (message, index) =>
        index > runUserIndex && readSessionMessageIdentity(message)?.role === "user",
    );
    return { start: runUserIndex + 1, end: end >= 0 ? end : messages.length };
  }
  const end = messages.length;
  return { start: lastUserMessageIndex(messages, end) + 1, end };
}

export function streamCausalInsertIndex(
  messages: unknown[],
  desiredTimestamp: number,
  startIndex: number,
  endIndex: number,
  readTimestamp: (message: unknown) => number | null,
): number {
  for (let index = startIndex; index < endIndex; index++) {
    const timestamp = readTimestamp(messages[index]);
    if (timestamp != null && timestamp > desiredTimestamp) {
      return index;
    }
  }
  return endIndex;
}

export function streamCausalTimestamp(
  messages: unknown[],
  index: number,
  desiredTimestamp: number,
  readTimestamp: (message: unknown) => number | null,
): number {
  let previousTimestamp: number | null = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    previousTimestamp = readTimestamp(messages[cursor]);
    if (previousTimestamp != null) {
      break;
    }
  }
  let nextTimestamp: number | null = null;
  for (let cursor = index; cursor < messages.length; cursor += 1) {
    nextTimestamp = readTimestamp(messages[cursor]);
    if (nextTimestamp != null) {
      break;
    }
  }
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

export function resolveCumulativeAssistantTail(
  messages: unknown[],
  cumulativeText: string,
  runId: string,
  endIndex = messages.length,
): string | null {
  let ownedPrefixIndex = -1;
  for (let index = 0; index < endIndex; index += 1) {
    const message = messages[index];
    const identity = readSessionMessageIdentity(message);
    const persistedText = identity?.runId === runId ? extractText(message) : null;
    if (
      identity?.role === "assistant" &&
      persistedText &&
      (cumulativeText.startsWith(persistedText) || persistedText.startsWith(cumulativeText))
    ) {
      ownedPrefixIndex = index;
      break;
    }
  }
  const turnStart =
    ownedPrefixIndex >= 0 ? ownedPrefixIndex : lastUserMessageIndex(messages, endIndex) + 1;
  let persistedPrefixLength = 0;
  for (let index = turnStart; index < endIndex; index += 1) {
    const identity = readSessionMessageIdentity(messages[index]);
    if (identity?.role !== "assistant" || (identity.runId && identity.runId !== runId)) {
      continue;
    }
    const persistedText = extractText(messages[index]);
    if (!persistedText) {
      continue;
    }
    const remaining = cumulativeText.slice(persistedPrefixLength);
    if (remaining.startsWith(persistedText)) {
      persistedPrefixLength += persistedText.length;
      continue;
    }
    if (persistedText.startsWith(remaining)) {
      return null;
    }
    const whitespace = persistedPrefixLength > 0 ? /^\s+/u.exec(remaining)?.[0] : undefined;
    if (whitespace && remaining.slice(whitespace.length).startsWith(persistedText)) {
      persistedPrefixLength += whitespace.length + persistedText.length;
      continue;
    }
    if (whitespace && persistedText.startsWith(remaining.slice(whitespace.length))) {
      return null;
    }
    if (persistedPrefixLength > 0) {
      break;
    }
  }
  return cumulativeText.slice(persistedPrefixLength);
}

function persistedBoundaryPrefix(state: StreamCausalBoundaryState, terminalText: string) {
  const messages = state.chatMessages;
  const activeRunId = state.chatRunId;
  if (!Array.isArray(messages) || !activeRunId) {
    return null;
  }
  const boundary = latestPersistedSteerBoundary(messages, activeRunId);
  if (!boundary || boundary.index <= 0) {
    return null;
  }
  const tail = resolveCumulativeAssistantTail(messages, terminalText, activeRunId, boundary.index);
  if (tail === terminalText) {
    return null;
  }
  return {
    boundaryRunId: boundary.runId,
    prefix: tail === null ? terminalText : terminalText.slice(0, terminalText.length - tail.length),
  };
}

export function markChatStreamAfterBoundary(
  host: StreamRolloverState,
  options: { runId: string; boundaryRunId: string; timestamp?: number },
): void {
  if (
    host.chatRunId !== options.runId ||
    latestStreamBoundaryRunId(host) === options.boundaryRunId
  ) {
    return;
  }
  const previousBoundaryRunId = latestStreamBoundaryRunId(host);
  host.chatStreamSegments = [
    ...(host.chatStreamSegments ?? []),
    {
      text: "",
      ts: options.timestamp ?? Date.now(),
      runId: options.runId,
      boundaryRunId: options.boundaryRunId,
      boundaryMarker: true,
      ...(previousBoundaryRunId ? { afterBoundaryRunId: previousBoundaryRunId } : {}),
    },
  ];
}

function replaceTerminalText(
  message: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  if (Array.isArray(message.content)) {
    let replaced = false;
    const content = message.content.flatMap((block) => {
      const entry = asNullableRecord(block);
      if (!entry) {
        return [block];
      }
      const textBlock =
        (entry.type === "text" || entry.type === "input_text" || entry.type === "output_text") &&
        typeof entry.text === "string";
      if (!textBlock) {
        return [block];
      }
      if (replaced) {
        return [];
      }
      replaced = true;
      return [{ ...entry, text }];
    });
    if (replaced) {
      return { ...message, content };
    }
  }
  if (typeof message.content === "string") {
    return { ...message, content: text };
  }
  return typeof message.text === "string" ? { ...message, text } : message;
}

type TerminalStreamBoundaryReconciliation =
  | { kind: "none" }
  | {
      kind: "split";
      afterBoundaryRunId: string;
      replacedSegmentIndexes: number[];
      tailMessage: Record<string, unknown> | null;
    };

type TerminalBoundaryCandidate = {
  boundaryRunId: string;
  prefix: string;
};

function terminalBoundaryCandidateMatches(
  candidate: TerminalBoundaryCandidate | null,
  terminalText: string,
): candidate is TerminalBoundaryCandidate {
  return Boolean(candidate?.boundaryRunId && terminalText.startsWith(candidate.prefix));
}

/** Reconciles a run-level cumulative terminal against its last persisted steer. */
export function reconcileTerminalStreamBoundary(
  message: Record<string, unknown>,
  state: StreamCausalBoundaryState,
): TerminalStreamBoundaryReconciliation {
  const terminalText = extractText(message);
  if (!terminalText) {
    return { kind: "none" };
  }
  let accumulatedText: string | null = null;
  const accumulatedSegmentIndexes: number[] = [];
  let liveBoundary: (TerminalBoundaryCandidate & { segmentIndexes: number[] }) | null = null;
  for (const [segmentIndex, segment] of (state.chatStreamSegments ?? []).entries()) {
    if (streamSegmentUsesAccumulatedText(segment) && typeof segment.text === "string") {
      const nextAccumulatedText = advanceAccumulatedStreamText(accumulatedText, segment.text);
      if (nextAccumulatedText !== accumulatedText) {
        accumulatedSegmentIndexes.push(segmentIndex);
      }
      accumulatedText = nextAccumulatedText;
    }
    const boundaryRunId = normalizeOptionalString(segment.boundaryRunId);
    if (boundaryRunId && accumulatedText) {
      liveBoundary = {
        boundaryRunId,
        prefix: accumulatedText,
        segmentIndexes: [...accumulatedSegmentIndexes],
      };
    }
  }
  const persistedBoundary = persistedBoundaryPrefix(state, terminalText);
  const selectedBoundary = terminalBoundaryCandidateMatches(liveBoundary, terminalText)
    ? liveBoundary
    : terminalBoundaryCandidateMatches(persistedBoundary, terminalText)
      ? persistedBoundary
      : null;
  if (!selectedBoundary) {
    return { kind: "none" };
  }
  const tail = terminalText.slice(selectedBoundary.prefix.length).trimStart();
  return {
    kind: "split",
    afterBoundaryRunId: selectedBoundary.boundaryRunId,
    replacedSegmentIndexes:
      selectedBoundary === persistedBoundary && liveBoundary ? liveBoundary.segmentIndexes : [],
    tailMessage: tail ? replaceTerminalText(message, tail) : null,
  };
}

/** Closes cumulative assistant output at a tool or persisted user boundary. */
export function rolloverChatStream(
  host: StreamRolloverState,
  options: {
    runId: string;
    boundaryRunId?: string;
    toolCallId?: string;
    timestamp?: number;
  },
): void {
  if (host.chatRunId !== options.runId) {
    return;
  }
  let segments = host.chatStreamSegments ?? [];
  let previousBoundaryRunId: string | undefined;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    previousBoundaryRunId = normalizeOptionalString(segments[index]?.boundaryRunId);
    if (previousBoundaryRunId) {
      break;
    }
  }
  const hasStream = typeof host.chatStream === "string";
  const hasStreamText = hasStream && Boolean(host.chatStream?.trim());
  if (options.boundaryRunId) {
    const previousBoundaryIndex = segments.findLastIndex((segment) => segment.boundaryRunId);
    segments = segments.map((segment, index) =>
      index <= previousBoundaryIndex || segment.boundaryRunId
        ? segment
        : { ...segment, boundaryRunId: options.boundaryRunId },
    );
    if (
      !hasStreamText &&
      !segments.some((segment) => segment.boundaryRunId === options.boundaryRunId)
    ) {
      segments = [
        ...segments,
        {
          text: "",
          ts: host.chatStreamStartedAt ?? options.timestamp ?? Date.now(),
          runId: options.runId,
          boundaryRunId: options.boundaryRunId,
          boundaryMarker: true,
          ...(previousBoundaryRunId ? { afterBoundaryRunId: previousBoundaryRunId } : {}),
        },
      ];
    }
  }
  if (hasStreamText) {
    segments = [
      ...segments,
      {
        text: host.chatStream ?? "",
        ts: host.chatStreamStartedAt ?? options.timestamp ?? Date.now(),
        runId: options.runId,
        ...(previousBoundaryRunId ? { afterBoundaryRunId: previousBoundaryRunId } : {}),
        ...(options.boundaryRunId ? { boundaryRunId: options.boundaryRunId } : {}),
        ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      },
    ];
  }
  host.chatStreamSegments = segments;
  if (!hasStream) {
    return;
  }
  host.chatStream = null;
  // The closed segment owns elapsed time; a later cumulative tail must not restart the run clock.
  host.chatStreamStartedAt = null;
}
