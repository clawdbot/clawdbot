import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import type {
  ResponseCompactionItemParam,
  ResponseOutputItem,
} from "openai/resources/responses/responses.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import { shortHash } from "../utils/hash.js";
import {
  OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE,
  OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH,
  type OpenAIResponsesCompactionReplayState,
  type OpenAIResponsesReasoningReplayMetadata,
  type OpenAIResponsesReplayContext,
  type ReplayableResponseCompactionItem,
} from "./openai-responses-contracts.js";

const OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE = "openai-responses-compaction-suppression";
const OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA = "rejected";
type OpenAIResponsesCompactionSuppressionState = ProviderReplayState & {
  type: typeof OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE;
  data: typeof OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA;
  baseUrlHash: string;
};

/** Removes prefix-bound checkpoint state while preserving route-scoped suppression state. */
export function stripOpenAIResponsesCompactionReplayCheckpoint(
  message: AssistantMessage,
): AssistantMessage {
  if (message.providerReplay?.type !== OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE) {
    return message;
  }
  const replaySafeMessage = { ...message };
  delete replaySafeMessage.providerReplay;
  return replaySafeMessage;
}

function hashOptionalReplayContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

export function buildOpenAIResponsesReplayContext(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): OpenAIResponsesReplayContext {
  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrlHash: hashOptionalReplayContextValue(model.baseUrl),
    sessionHash: hashOptionalReplayContextValue(options?.sessionId),
    authProfileHash: hashOptionalReplayContextValue(options?.authProfileId),
  };
}

function isOpenAIResponsesCompactionReplayState(
  value: unknown,
): value is OpenAIResponsesCompactionReplayState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return (
    state.v === 1 &&
    state.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE &&
    typeof state.data === "string" &&
    state.data.length > 0 &&
    (state.id === undefined || typeof state.id === "string") &&
    (state.replayIndex === undefined ||
      (Number.isSafeInteger(state.replayIndex) && (state.replayIndex as number) >= 0)) &&
    typeof state.provider === "string" &&
    typeof state.api === "string" &&
    typeof state.model === "string" &&
    typeof state.baseUrlHash === "string" &&
    (state.sessionHash === undefined || typeof state.sessionHash === "string") &&
    (state.authProfileHash === undefined || typeof state.authProfileHash === "string")
  );
}

function isOpenAIResponsesCompactionSuppressionState(
  value: unknown,
): value is OpenAIResponsesCompactionSuppressionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return (
    state.v === 1 &&
    state.type === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE &&
    state.data === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA &&
    typeof state.provider === "string" &&
    typeof state.api === "string" &&
    typeof state.model === "string" &&
    typeof state.baseUrlHash === "string" &&
    (state.sessionHash === undefined || typeof state.sessionHash === "string") &&
    (state.authProfileHash === undefined || typeof state.authProfileHash === "string")
  );
}

function replayContextMatches(
  state: OpenAIResponsesReplayContext,
  context: OpenAIResponsesReplayContext,
): boolean {
  // Replay state is scoped to the exact request identity that captured it.
  return (
    state.provider === context.provider &&
    state.api === context.api &&
    state.model === context.model &&
    state.baseUrlHash === context.baseUrlHash &&
    state.sessionHash === context.sessionHash &&
    state.authProfileHash === context.authProfileHash
  );
}

export function captureOpenAIResponsesCompaction(
  output: Pick<AssistantMessage, "providerReplay">,
  item: ReplayableResponseCompactionItem,
  replayIndex: number | undefined,
  model: Model,
  captureMetadata?: OpenAIResponsesReasoningReplayMetadata,
): void {
  const metadata = captureMetadata ?? buildOpenAIResponsesReasoningReplayMetadata(model);
  if (!item.encrypted_content || !metadata?.baseUrlHash) {
    return;
  }
  if (
    isOpenAIResponsesCompactionReplayState(output.providerReplay) &&
    (output.providerReplay.replayIndex ?? -1) > (replayIndex ?? Number.MAX_SAFE_INTEGER)
  ) {
    return;
  }
  output.providerReplay = {
    v: 1,
    type: OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE,
    ...(item.id ? { id: item.id } : {}),
    data: item.encrypted_content,
    ...(replayIndex === undefined ? {} : { replayIndex }),
    provider: metadata.provider,
    api: metadata.api,
    model: metadata.model,
    baseUrlHash: metadata.baseUrlHash,
    ...(metadata.sessionHash ? { sessionHash: metadata.sessionHash } : {}),
    ...(metadata.authProfileHash ? { authProfileHash: metadata.authProfileHash } : {}),
  };
}

export function suppressOpenAIResponsesCompaction(
  output: Pick<AssistantMessage, "providerReplay">,
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): void {
  const context = buildOpenAIResponsesReplayContext(model, options);
  if (!context.baseUrlHash) {
    return;
  }
  output.providerReplay = {
    v: 1,
    type: OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE,
    data: OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA,
    ...context,
    baseUrlHash: context.baseUrlHash,
  };
}

export function createCompactionTracker(
  output: Pick<AssistantMessage, "providerReplay">,
  model: Model,
  options?: { reasoningReplayMetadata?: OpenAIResponsesReasoningReplayMetadata },
) {
  const replayIndexes = new Map<string, number>();
  return {
    added(item: Pick<ResponseOutputItem, "type"> & { id?: string }, replayIndex: number): void {
      if (item.type === "compaction" && item.id) {
        replayIndexes.set(item.id, replayIndex);
      }
    },
    completed(
      item: Pick<ResponseOutputItem, "type"> & {
        id?: string;
        encrypted_content?: string | null;
      },
      fallbackReplayIndex: number,
    ): void {
      if (item.type !== "compaction" || !item.encrypted_content) {
        return;
      }
      captureOpenAIResponsesCompaction(
        output,
        {
          type: "compaction",
          ...(item.id ? { id: item.id } : {}),
          encrypted_content: item.encrypted_content,
        },
        (item.id ? replayIndexes.get(item.id) : undefined) ?? fallbackReplayIndex,
        model,
        options?.reasoningReplayMetadata,
      );
      if (item.id) {
        replayIndexes.delete(item.id);
      }
    },
  };
}

export function isSafeResponsesReplayItemId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH
  );
}

function prepareOpenAIResponsesCompactionForReplay(
  value: unknown,
  context: OpenAIResponsesReplayContext,
): { item: ResponseCompactionItemParam; replayIndex: number } | undefined {
  if (!isOpenAIResponsesCompactionReplayState(value) || !replayContextMatches(value, context)) {
    return undefined;
  }
  return {
    item: {
      type: "compaction",
      ...(isSafeResponsesReplayItemId(value.id) ? { id: value.id } : {}),
      encrypted_content: value.data,
    },
    replayIndex: value.replayIndex ?? 0,
  };
}

function resolveNewestOpenAIResponsesCompactionReplay(
  messages: Context["messages"],
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): { owner: AssistantMessage; item: ResponseCompactionItemParam; replayIndex: number } | undefined {
  const context = buildOpenAIResponsesReplayContext(model, options);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    if (isOpenAIResponsesCompactionSuppressionState(message.providerReplay)) {
      // A successful encrypted-content fallback records this provider-owned
      // tombstone so later turns never retry an already rejected compaction.
      if (replayContextMatches(message.providerReplay, context)) {
        return undefined;
      }
      continue;
    }
    if (message.providerReplay?.type !== OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE) {
      continue;
    }
    const replay = prepareOpenAIResponsesCompactionForReplay(message.providerReplay, context);
    return replay ? { owner: message, ...replay } : undefined;
  }
  return undefined;
}

export type OpenAIResponsesReplayMode = "checkpoint" | "full-history";

type OpenAIResponsesCompactionReplayPlan = {
  messages: Context["messages"];
  compaction?: ResponseCompactionItemParam;
  preserveUnframedToolResults: boolean;
};

export function buildOpenAIResponsesCompactionReplayPlan(
  messages: Context["messages"],
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId"> & {
    mode?: OpenAIResponsesReplayMode;
  },
): OpenAIResponsesCompactionReplayPlan {
  if (options?.mode === "full-history") {
    // Checkpoint rejection must rebuild from the untouched transcript; consulting
    // providerReplay here would recreate the same rejected compaction window.
    return { messages, preserveUnframedToolResults: false };
  }
  const compaction = resolveNewestOpenAIResponsesCompactionReplay(messages, model, options);
  if (!compaction) {
    return { messages, preserveUnframedToolResults: false };
  }
  const ownerIndex = messages.indexOf(compaction.owner);
  const owner = {
    ...compaction.owner,
    content: compaction.owner.content.slice(compaction.replayIndex),
  };
  // Slice before transcript repair so compacted calls cannot synthesize outputs,
  // while real results emitted after the checkpoint remain in chronological order.
  return {
    messages: [owner, ...messages.slice(ownerIndex + 1)],
    compaction: compaction.item,
    preserveUnframedToolResults: true,
  };
}

export function buildOpenAIResponsesReasoningReplayMetadata(
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
): OpenAIResponsesReasoningReplayMetadata {
  return {
    v: 1,
    source: "openai-responses",
    ...buildOpenAIResponsesReplayContext(model, options),
  };
}
