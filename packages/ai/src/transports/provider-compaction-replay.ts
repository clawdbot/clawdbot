import type { AssistantMessage, ProviderReplayState } from "@openclaw/llm-core";

/** Whether provider replay state is a prefix-bound server compaction checkpoint. */
export function isCompactionReplayCheckpoint(replay: unknown): replay is ProviderReplayState {
  const type =
    replay && typeof replay === "object" ? (replay as { type?: unknown }).type : undefined;
  return (
    type === "anthropic-compaction" ||
    type === "openai-responses-compaction" ||
    type === "openai-responses-retained-compaction"
  );
}

/** Strip prefix-bound checkpoints after local history rewrites. */
export function stripCompactionReplayCheckpoint(message: AssistantMessage): AssistantMessage {
  if (!isCompactionReplayCheckpoint(message.providerReplay)) {
    return message;
  }
  const replaySafeMessage = { ...message };
  delete replaySafeMessage.providerReplay;
  return replaySafeMessage;
}

/** Strip prefix-bound checkpoint state from an in-place message rewrite. */
export function stripCompactionReplayCheckpointInPlace(message: {
  providerReplay?: unknown;
}): void {
  if (isCompactionReplayCheckpoint(message.providerReplay)) {
    delete message.providerReplay;
  }
}

/** Reindex a prefix-bound checkpoint after known content removals. */
export function replaceCompactionReplayOwnerContent(
  message: AssistantMessage,
  content: AssistantMessage["content"],
): AssistantMessage {
  const next = { ...message, content };
  const replay = message.providerReplay;
  if (!isCompactionReplayCheckpoint(replay)) {
    return next;
  }
  if (replay.type === "openai-responses-retained-compaction") {
    // This checkpoint is anchored to retained user turns, not assistant content indexes.
    return next;
  }
  const replayIndex = replay.replayIndex ?? 0;
  if (
    (content.length === 0 && message.content.length > 0) ||
    replayIndex > message.content.length
  ) {
    return stripCompactionReplayCheckpoint(next);
  }
  let sourceIndex = 0;
  let nextReplayIndex = 0;
  const unambiguous = content.every((block) => {
    const index = message.content.indexOf(block, sourceIndex);
    sourceIndex = index + 1;
    nextReplayIndex += index >= 0 && index < replayIndex ? 1 : 0;
    return index >= 0;
  });
  if (!unambiguous) {
    return stripCompactionReplayCheckpoint(next);
  }
  return nextReplayIndex === replayIndex
    ? next
    : { ...next, providerReplay: { ...replay, replayIndex: nextReplayIndex } };
}
