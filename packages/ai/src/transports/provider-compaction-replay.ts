import type { AssistantMessage, Model, ProviderReplayState } from "@openclaw/llm-core";
import { resolveNewestAnthropicCompaction } from "./anthropic-compaction-replay.js";
import { resolveAnthropicServerCompactionPlan } from "./anthropic-payload-policy.js";
import {
  CompactionReplayRefreshRequiredError,
  resolveNewestOpenAIResponsesCompactionReplay,
} from "./openai-responses-compaction-replay.js";
import { OPENAI_RESPONSES_APIS } from "./openai-responses-contracts.js";

export { CompactionReplayRefreshRequiredError } from "./openai-responses-compaction-replay.js";

type ReplayIdentity = { sessionId?: string; authProfileId?: string; enabled?: boolean };
type ReplayMessage = { role: string };
type ReplayPressureEstimator = {
  text(value: string): number;
  image(): number;
  json(value: unknown): number;
};

function isAssistantReplayMessage<T extends ReplayMessage>(
  message: T,
): message is T & AssistantMessage {
  return message.role === "assistant";
}

/** Resolve from prepared transport facts; never retain or return credential material. */
export function resolveCompactionReplayEligibility(
  model: Model,
  options: { extraParams?: Record<string, unknown>; apiKey?: string },
): boolean {
  if (OPENAI_RESPONSES_APIS.has(model.api)) {
    return true;
  }
  return (
    Boolean(options.apiKey?.trim()) &&
    resolveAnthropicServerCompactionPlan(model, options.extraParams, options.apiKey).enabled
  );
}

function resolveCompactionSource<T extends ReplayMessage>(
  messages: readonly T[],
  model: Model,
  identity: ReplayIdentity,
) {
  if (identity.enabled === false) {
    return undefined;
  }
  const assistants = messages.filter(isAssistantReplayMessage);
  const selected = (() => {
    if (OPENAI_RESPONSES_APIS.has(model.api)) {
      const responses = resolveNewestOpenAIResponsesCompactionReplay(assistants, model, identity);
      return responses ? { family: "responses" as const, ...responses } : undefined;
    }
    if (identity.enabled !== true) {
      return undefined;
    }
    const anthropic = resolveNewestAnthropicCompaction(assistants, model, identity);
    return anthropic ? { family: "anthropic" as const, ...anthropic } : undefined;
  })();
  if (!selected) {
    return undefined;
  }
  const owner = assistants.find((message) => message === selected.owner);
  return owner ? { ...selected, owner } : undefined;
}

/** Manual recovery uses the durable client compactor, never a guessed retained-user prefix. */
export function requiresCompactionReplayRefresh(
  messages: readonly ReplayMessage[],
  model: Model,
  identity: ReplayIdentity,
): boolean {
  const checkpoint = resolveCompactionSource(messages, model, identity);
  return checkpoint?.family === "responses" && checkpoint.mode === "refresh-required";
}

/** Carry a checkpoint immediately after reference-preserving history limiting, before repair. */
export function preserveCompactionReplayWindow<T extends ReplayMessage>(
  source: readonly T[],
  windowed: T[],
  model: Model,
  identity: ReplayIdentity,
): T[] {
  const checkpoint = resolveCompactionSource(source, model, identity);
  if (!checkpoint || windowed.some((message) => message === checkpoint.owner)) {
    return windowed;
  }
  const owner = checkpoint.owner;
  const replay = checkpoint.owner.providerReplay;
  // Retained-user state has no content index, including its refresh-required barrier.
  const providerReplay =
    replay?.type === "openai-responses-retained-compaction"
      ? replay
      : { ...replay, replayIndex: 0 };
  // The limiter can preserve a leading prelude that this checkpoint already
  // covers. Only the original suffix may follow its projected owner.
  const suffix = new Set(source.slice(source.indexOf(owner) + 1));
  return [
    { ...owner, content: [], providerReplay },
    ...windowed.filter((message) => suffix.has(message)),
  ];
}

function estimateResponsesWindow(
  checkpoint: NonNullable<ReturnType<typeof resolveNewestOpenAIResponsesCompactionReplay>> & {
    mode: "complete-window";
  },
  estimate: ReplayPressureEstimator,
): number {
  return checkpoint.output.reduce((tokens, entry) => {
    if (entry.type === "compaction") {
      const { encrypted_content, ...metadata } = entry;
      return tokens + estimate.text(encrypted_content) + estimate.json(metadata);
    }
    const { content, ...metadata } = entry;
    return (
      tokens +
      estimate.json(metadata) +
      content.reduce((sum, block) => {
        if (block.type === "input_text") {
          const { text, ...fields } = block;
          return sum + estimate.text(text) + estimate.json(fields);
        }
        if (block.type === "input_image") {
          const { image_url: _imageUrl, ...fields } = block;
          return (
            sum +
            estimate.image() +
            estimate.json(block.image_url?.startsWith("data:") ? fields : block)
          );
        }
        return sum + estimate.json(block);
      }, 0)
    );
  }, 0);
}

/** Estimate the canonical prefix and its tail once, independent of unbound usage snapshots. */
export function resolveCompactionReplayPressure<T extends ReplayMessage>(
  messages: T[],
  model: Model,
  identity: ReplayIdentity,
  estimate: ReplayPressureEstimator,
): { messages: T[]; prefixTokens: number } | undefined {
  const checkpoint = resolveCompactionSource(messages, model, identity);
  if (!checkpoint) {
    return undefined;
  }
  if (checkpoint.family === "responses" && checkpoint.mode === "refresh-required") {
    throw new CompactionReplayRefreshRequiredError();
  }
  const ownerIndex = messages.findIndex((message) => message === checkpoint.owner);
  const owner = messages[ownerIndex];
  if (!owner) {
    return undefined;
  }
  const prefixTokens =
    checkpoint.family === "anthropic"
      ? estimate.text(checkpoint.summary)
      : checkpoint.mode === "complete-window"
        ? estimateResponsesWindow(checkpoint, estimate)
        : estimate.text(checkpoint.item.encrypted_content);
  // Persisted usage does not identify the checkpoint sent with that request.
  // Route/auth/config may have changed away and back; keep billing, not pressure authority.
  const { contextUsage: _staleContextUsage, ...usage } = checkpoint.owner.usage;
  const tail: T[] = [];
  for (const message of messages.slice(ownerIndex + 1)) {
    if (!isAssistantReplayMessage(message) || message.usage.contextUsage === undefined) {
      tail.push(message);
      continue;
    }
    const { contextUsage: _unboundContextUsage, ...billedUsage } = message.usage;
    tail.push({ ...message, usage: billedUsage });
  }
  return {
    messages: [
      { ...owner, content: checkpoint.owner.content.slice(checkpoint.replayIndex), usage },
      ...tail,
    ],
    prefixTokens,
  };
}

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
