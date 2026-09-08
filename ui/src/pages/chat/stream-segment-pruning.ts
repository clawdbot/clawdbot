import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import {
  accumulatedStreamText,
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import {
  streamCausalInterval,
  resolveCumulativeAssistantTail,
  type StreamCausalBoundaryState,
} from "./stream-causal-boundary.ts";
import {
  hasAssistantStreamPartReplacement,
  visibleAssistantStreamParts,
} from "./stream-reconciliation.ts";
import {
  extractToolMessageRefs,
  resolveLiveToolStreamRefs,
  resolveMatchingLiveToolIdentity,
} from "./tool-stream-identity.ts";

type StreamSegmentPruningState = StreamCausalBoundaryState & {
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatToolMessages?: unknown[];
  toolStreamById?: Map<string, unknown>;
  toolStreamOrder?: unknown[];
};

type AssistantMessageVisibility = (message: unknown) => boolean;
type StreamVisibility = (stream: string) => boolean;

function pruneAccumulatedStreamSegments(
  segments: readonly ChatStreamSegment[],
  activeRunId: string | null | undefined,
  shouldPrune: (segment: ChatStreamSegment, index: number) => boolean,
  retiredItemId?: string,
): ChatStreamSegment[] {
  return segments.flatMap((segment, index) => {
    if (!shouldPrune(segment, index)) {
      return [segment];
    }
    // Durable rows replace display, not the producer's cumulative baseline.
    // A segment owned by a different run than the active one has no future
    // deltas to trim, so retaining it would leak sibling-run state.
    const foreignRun = Boolean(segment.runId && activeRunId && segment.runId !== activeRunId);
    return !foreignRun && streamSegmentUsesAccumulatedText(segment)
      ? [{ ...segment, persisted: true as const, ...(retiredItemId ? { retiredItemId } : {}) }]
      : [];
  });
}

export function discardStreamSegmentIndexes(
  state: StreamCausalBoundaryState,
  discardedIndexes: readonly number[],
): void {
  if (!state.chatStreamSegments || discardedIndexes.length === 0) {
    return;
  }
  const discarded = new Set(discardedIndexes);
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (_segment, index) => discarded.has(index),
  );
}

export function reconcilePersistedAssistantStream(state: StreamSegmentPruningState): void {
  const runId = state.chatRunId;
  if (!runId) {
    return;
  }
  for (const [index, segment] of (state.chatStreamSegments ?? []).entries()) {
    if (segment.runId !== runId || !segment.itemId || !segment.pendingStreamText) {
      continue;
    }
    const handoff = retireCommentaryStream(state, {
      runId,
      itemId: segment.itemId,
      text: segment.text,
      timestamp: segment.ts,
      pendingStreamText: segment.pendingStreamText,
    });
    const segments = [...(state.chatStreamSegments ?? [])];
    segments[index] = {
      ...segment,
      text: handoff?.text ?? segment.text,
      pendingStreamText: handoff?.pendingStreamText,
    };
    state.chatStreamSegments = segments;
  }
  const stream = state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
  if (!stream) {
    return;
  }
  const messages = (state.chatMessages ?? []).filter((message) => {
    const identity = readSessionMessageIdentity(message);
    return (
      identity?.role === "assistant" &&
      identity.id &&
      !identity.isImported &&
      identity.runId === runId &&
      !readAssistantStreamSegmentIdentity(message)
    );
  });
  const tail = resolveCumulativeAssistantTail(messages, stream, runId);
  const prefix = stream.slice(0, stream.length - (tail?.length ?? 0));
  if (!prefix) {
    return;
  }
  retireCumulativePrefix(state, runId, prefix, Date.now());
}

function retireCumulativePrefix(
  state: StreamSegmentPruningState,
  runId: string,
  prefix: string,
  timestamp: number,
  retirement?: { itemId: string; segmentIndex?: number },
): void {
  const stream = state.chatStream ?? accumulatedStreamText(state.chatStreamSegments ?? []);
  let segments = state.chatStreamSegments ?? [];
  const accumulated = state.chatStream === null ? stream : accumulatedStreamText(segments);
  const shouldPrune = (segment: ChatStreamSegment, index: number) =>
    (!retirement || index === retirement.segmentIndex) &&
    segment.persisted !== true &&
    segment.runId === runId &&
    streamSegmentUsesAccumulatedText(segment) &&
    prefix.startsWith(segment.text);
  // Preserve renderer identity fast paths when persistence retires no segments.
  if (segments.some(shouldPrune)) {
    segments = pruneAccumulatedStreamSegments(segments, runId, shouldPrune, retirement?.itemId);
    state.chatStreamSegments = segments;
  }
  if (advanceAccumulatedStreamText(accumulated, prefix) === accumulated) {
    return;
  }
  // Persistence can overtake chat deltas. Retire only the observed cumulative
  // prefix; keep the received buffer intact so later deltas cannot restart it.
  const last = segments.at(-1);
  const extendsPersisted =
    last?.persisted &&
    last.runId === runId &&
    !last.boundaryRunId &&
    !last.toolCallId &&
    !last.retiredItemId &&
    !retirement;
  state.chatStreamSegments = [
    ...(extendsPersisted ? segments.slice(0, -1) : segments),
    {
      ...(extendsPersisted ? last : {}),
      text: prefix,
      ts: state.chatStreamStartedAt ?? timestamp,
      runId,
      persisted: true,
      ...(retirement ? { retiredItemId: retirement.itemId } : {}),
    },
  ];
}

/** Transfer one complete cumulative occurrence to its first keyed owner. */
export function retireCommentaryStream(
  state: StreamSegmentPruningState,
  commentary: {
    runId: string;
    itemId: string;
    text: string;
    timestamp: number;
    pendingStreamText?: string;
  },
): { text: string; pendingStreamText?: string } | null {
  if (
    state.chatRunId !== commentary.runId ||
    state.chatStreamSegments?.some(
      (segment) =>
        segment.runId === commentary.runId && segment.retiredItemId === commentary.itemId,
    )
  ) {
    return null;
  }
  const part = visibleAssistantStreamParts(state, {
    includeCurrent: true,
    isHiddenStreamText: () => false,
  }).at(-1);
  if (!part || part.itemId || part.runId !== commentary.runId || part.boundaryRunId) {
    return null;
  }
  if (
    commentary.pendingStreamText &&
    !part.replacementText.startsWith(commentary.pendingStreamText)
  ) {
    return null;
  }
  const preceding = (state.chatStreamSegments ?? []).slice(0, part.segmentIndex);
  const prefix = accumulatedStreamText(preceding);
  const rawTail =
    prefix && part.replacementText.startsWith(prefix)
      ? part.replacementText.slice(prefix.length)
      : part.replacementText;
  const text = stripInlineDirectiveTagsForDelivery(rawTail)
    .text.replace(/^(?:[ \t]*\r?\n)+/u, "")
    .trimEnd();
  // The preamble producer flattens whitespace. Keep the cumulative formatting
  // when that exact projection identifies the same complete occurrence.
  const projectedText = text.replace(/\s+/gu, " ").trim();
  if (!text || (text !== commentary.text && projectedText !== commentary.text)) {
    // Item events can overtake the last chat delta. Only that observed prefix
    // may complete this pending handoff; a later unrelated occurrence cannot.
    return projectedText && commentary.text.startsWith(projectedText)
      ? { text: commentary.text, pendingStreamText: part.replacementText }
      : null;
  }
  retireCumulativePrefix(state, commentary.runId, part.replacementText, commentary.timestamp, {
    itemId: commentary.itemId,
    segmentIndex: part.segmentIndex,
  });
  return { text };
}

/** A durable commentary row immediately replaces its keyed live projection.
 * Waiting for terminal cleanup renders both copies throughout the active run. */
export function prunePersistedAssistantStreamSegments(
  state: StreamCausalBoundaryState,
  message: unknown,
): void {
  const identity = readAssistantStreamSegmentIdentity(message);
  if (!identity || !state.chatStreamSegments) {
    return;
  }
  const replacedIndexes = state.chatStreamSegments.flatMap((segment, index) => {
    const runId = normalizeOptionalString(segment.runId);
    // Client-materialized commentary can be untagged; known run ownership
    // must still prevent a reused item id from pruning a sibling run.
    const sameRun = !identity.runId || !runId || identity.runId === runId;
    return normalizeOptionalString(segment.itemId) === identity.itemId && sameRun ? [index] : [];
  });
  discardStreamSegmentIndexes(state, replacedIndexes);
}

export function pruneHistoryReplacedStreamSegments(
  messages: unknown[],
  state: StreamSegmentPruningState,
  opts: {
    isHiddenAssistantMessage: AssistantMessageVisibility;
    isHiddenStreamText: StreamVisibility;
    persistCommentary?: boolean;
  },
): boolean {
  if (!Array.isArray(state.chatStreamSegments)) {
    return false;
  }
  const replacedIndexes = new Set<number>();
  for (const part of visibleAssistantStreamParts(state, {
    includeCurrent: false,
    isHiddenStreamText: opts.isHiddenStreamText,
  })) {
    if (part.segmentIndex === undefined || (part.itemId && opts.persistCommentary !== true)) {
      continue;
    }
    const interval = streamCausalInterval(messages, part);
    if (
      hasAssistantStreamPartReplacement(
        messages,
        part,
        opts.isHiddenAssistantMessage,
        interval.start,
        interval.end,
      )
    ) {
      replacedIndexes.add(part.segmentIndex);
    }
  }
  if (replacedIndexes.size === 0) {
    return false;
  }
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (_segment, index) => replacedIndexes.has(index),
  );
  return true;
}

export function prunePersistedToolStreamMessages(
  state: StreamSegmentPruningState,
  persistedToolIds: Set<string>,
) {
  if (persistedToolIds.size === 0) {
    return;
  }
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  if (state.toolStreamById instanceof Map) {
    for (const id of persistedToolIds) {
      state.toolStreamById.delete(id);
    }
  }
  if (Array.isArray(state.toolStreamOrder)) {
    state.toolStreamOrder = state.toolStreamOrder.filter(
      (id): id is string => typeof id === "string" && !persistedToolIds.has(id),
    );
  }
  if (Array.isArray(state.chatToolMessages)) {
    state.chatToolMessages = state.chatToolMessages.filter((message) => {
      const refs = extractToolMessageRefs(message);
      return refs.every((ref) => {
        const identity = resolveMatchingLiveToolIdentity(ref, liveToolRefs);
        return identity === undefined || !persistedToolIds.has(identity);
      });
    });
  }
  if (!Array.isArray(state.chatStreamSegments)) {
    return;
  }
  let toolIndexedSegmentIndex = 0;
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    state.chatRunId,
    (segment) => {
      if (segment.boundaryMarker === true || segment.persisted === true) {
        return false;
      }
      const explicitToolCallId = normalizeOptionalString(segment.toolCallId);
      const usesItemId = streamSegmentHasItemId(segment);
      const indexedToolRef = usesItemId ? undefined : liveToolRefs[toolIndexedSegmentIndex];
      if (!usesItemId) {
        toolIndexedSegmentIndex += 1;
      }
      const segmentRunId = normalizeOptionalString(segment.runId);
      const toolIdentity = explicitToolCallId
        ? resolveMatchingLiveToolIdentity(
            {
              id: explicitToolCallId,
              ...(segmentRunId ? { runId: segmentRunId } : {}),
            },
            liveToolRefs,
          )
        : indexedToolRef?.identity;
      return Boolean(toolIdentity && persistedToolIds.has(toolIdentity));
    },
  );
}
