import type { AssistantMessage, ProviderReplayState } from "@openclaw/llm-core";

const SERVER_COMPACTION_REPLAY_TYPES = new Set([
  "anthropic-compaction",
  "openai-responses-compaction",
]);

/** Whether provider replay state is a prefix-bound server compaction checkpoint. */
export function isCompactionReplayCheckpoint(replay: ProviderReplayState | undefined): boolean {
  return replay !== undefined && SERVER_COMPACTION_REPLAY_TYPES.has(replay.type);
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
