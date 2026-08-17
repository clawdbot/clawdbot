import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  advanceAccumulatedStreamText,
  streamSegmentHasItemId,
  streamSegmentUsesAccumulatedText,
  trimAccumulatedStreamPrefix,
  type ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import { streamCausalInterval, type StreamCausalBoundaryState } from "./stream-causal-boundary.ts";
import {
  hasAssistantStreamPartReplacement,
  visibleAssistantStreamParts,
  visibleCurrentAssistantStreamTail,
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
  shouldPrune: (segment: ChatStreamSegment, index: number) => boolean,
): ChatStreamSegment[] {
  let removedAccumulatedPrefix: string | null = null;
  return segments.flatMap((segment, index) => {
    if (shouldPrune(segment, index)) {
      if (streamSegmentUsesAccumulatedText(segment)) {
        removedAccumulatedPrefix = advanceAccumulatedStreamText(
          removedAccumulatedPrefix,
          segment.text,
        );
      }
      return [];
    }
    if (!removedAccumulatedPrefix || !streamSegmentUsesAccumulatedText(segment)) {
      return [segment];
    }
    return [
      { ...segment, text: trimAccumulatedStreamPrefix(segment.text, removedAccumulatedPrefix) },
    ];
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
    (_segment, index) => discarded.has(index),
  );
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
  const currentTail = visibleCurrentAssistantStreamTail(state, opts.isHiddenStreamText);
  state.chatStreamSegments = pruneAccumulatedStreamSegments(
    state.chatStreamSegments,
    (_segment, index) => replacedIndexes.has(index),
  );
  if (typeof state.chatStream === "string") {
    state.chatStream = currentTail;
    if (currentTail === null) {
      state.chatStreamStartedAt = null;
    }
  }
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
  state.chatStreamSegments = pruneAccumulatedStreamSegments(state.chatStreamSegments, (segment) => {
    if (segment.boundaryMarker === true) {
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
  });
}
