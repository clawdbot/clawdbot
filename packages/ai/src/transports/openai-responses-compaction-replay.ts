import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ResponseCompactionItemParam,
  ResponseOutputItem,
} from "openai/resources/responses/responses.js";
import type {
  BaseOpenAIStreamOptions,
  OpenAIResponsesCompactionRejection,
} from "../provider-options.js";
import { shortHash } from "../utils/hash.js";
import {
  OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE,
  OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE,
  OPENAI_RESPONSES_REPLAY_ITEM_ID_MAX_LENGTH,
  type OpenAIResponsesCompactionReplayState,
  type OpenAIResponsesReasoningReplayMetadata,
  type OpenAIResponsesReplayContext,
  type ReplayableResponseCompactionItem,
} from "./openai-responses-contracts.js";
import { log } from "./openai-transport-shared.js";

const OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE = "openai-responses-compaction-suppression";
const OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA = "rejected";
type OpenAIResponsesCompactionSuppressionState = ProviderReplayState & {
  type: typeof OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE;
  data: typeof OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA;
  baseUrlHash: string;
};

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

export function isOpenAIResponsesReplayContext(
  value: unknown,
): value is OpenAIResponsesReplayContext {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.provider === "string" &&
    typeof value.api === "string" &&
    typeof value.model === "string" &&
    (value.baseUrlHash === undefined || typeof value.baseUrlHash === "string") &&
    (value.sessionHash === undefined || typeof value.sessionHash === "string") &&
    (value.authProfileHash === undefined || typeof value.authProfileHash === "string")
  );
}

function isOpenAIResponsesCompactionState(
  state: OpenAIResponsesReplayContext & Record<string, unknown>,
): state is Record<string, unknown> &
  (OpenAIResponsesCompactionReplayState | OpenAIResponsesCompactionSuppressionState) {
  if (typeof state.baseUrlHash !== "string" || state.v !== 1) {
    return false;
  }
  if (state.type === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE) {
    return state.data === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_DATA;
  }
  if (state.type === OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE) {
    return (
      typeof state.data === "string" &&
      state.data.length > 0 &&
      (state.id === undefined || typeof state.id === "string") &&
      state.replayIndex === undefined
    );
  }
  return (
    state.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE &&
    typeof state.data === "string" &&
    state.data.length > 0 &&
    (state.id === undefined || typeof state.id === "string") &&
    (state.replayIndex === undefined ||
      (typeof state.replayIndex === "number" &&
        Number.isSafeInteger(state.replayIndex) &&
        state.replayIndex >= 0))
  );
}

function readOpenAIResponsesCompactionReplayState(
  value: unknown,
): OpenAIResponsesCompactionReplayState | OpenAIResponsesCompactionSuppressionState | undefined {
  return isRecord(value) &&
    isOpenAIResponsesReplayContext(value) &&
    isOpenAIResponsesCompactionState(value)
    ? value
    : undefined;
}

export function openAIResponsesReplayContextMatches(
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
  boundary: number | "retained-users",
  model: Model,
  captureMetadata?: OpenAIResponsesReasoningReplayMetadata,
): void {
  const metadata = captureMetadata ?? buildOpenAIResponsesReasoningReplayMetadata(model);
  if (!item.encrypted_content) {
    return;
  }
  if (!metadata?.baseUrlHash) {
    log.debug("[responses] skipping compaction capture: missing base URL hash");
    return;
  }
  const currentReplay = readOpenAIResponsesCompactionReplayState(output.providerReplay);
  if (
    typeof boundary === "number" &&
    currentReplay?.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE &&
    (currentReplay.replayIndex ?? -1) > boundary
  ) {
    return;
  }
  output.providerReplay = {
    v: 1,
    type:
      boundary === "retained-users"
        ? OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE
        : OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE,
    ...(item.id ? { id: item.id } : {}),
    data: item.encrypted_content,
    ...(typeof boundary === "number" ? { replayIndex: boundary } : {}),
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
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "onCompactionRejected" | "sessionId">,
  rejectedCheckpoint?: OpenAIResponsesCompactionRejection,
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
  if (rejectedCheckpoint) {
    options?.onCompactionRejected?.(rejectedCheckpoint);
  }
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

function resolveNewestOpenAIResponsesCompactionReplay(
  messages: Context["messages"],
  model: Model,
  options?: Pick<BaseOpenAIStreamOptions, "authProfileId" | "sessionId">,
):
  | {
      owner: AssistantMessage;
      item: ResponseCompactionItemParam;
      mode: "compacted-prefix";
      replayIndex: number;
    }
  | {
      owner: AssistantMessage;
      item: ResponseCompactionItemParam;
      mode: "retained-users";
    }
  | undefined {
  const context = buildOpenAIResponsesReplayContext(model, options);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const replay = readOpenAIResponsesCompactionReplayState(message.providerReplay);
    if (replay?.type === OPENAI_RESPONSES_COMPACTION_SUPPRESSION_TYPE) {
      // A successful encrypted-content fallback records this provider-owned
      // tombstone so later turns never retry an already rejected compaction.
      if (openAIResponsesReplayContextMatches(replay, context)) {
        return undefined;
      }
      continue;
    }
    if (
      replay?.type !== OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE &&
      replay?.type !== OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE
    ) {
      if (
        message.providerReplay?.type === OPENAI_RESPONSES_COMPACTION_REPLAY_TYPE ||
        message.providerReplay?.type === OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE
      ) {
        return undefined;
      }
      continue;
    }
    if (!openAIResponsesReplayContextMatches(replay, context)) {
      return undefined;
    }
    return {
      owner: message,
      item: {
        type: "compaction",
        ...(isSafeResponsesReplayItemId(replay.id) ? { id: replay.id } : {}),
        encrypted_content: replay.data,
      },
      ...(replay.type === OPENAI_RESPONSES_RETAINED_COMPACTION_REPLAY_TYPE
        ? { mode: "retained-users" as const }
        : { mode: "compacted-prefix" as const, replayIndex: replay.replayIndex ?? 0 }),
    };
  }
  return undefined;
}

export type OpenAIResponsesReplayMode = "checkpoint" | "full-history";

type OpenAIResponsesCompactionReplayPlan = {
  messages: Context["messages"];
  retainedMessages?: Context["messages"];
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
  const collectRetainedUserMessages = (prefix: Context["messages"]): Context["messages"] => {
    const previous = resolveNewestOpenAIResponsesCompactionReplay(prefix, model, options);
    if (!previous) {
      return prefix.filter((message) => message.role === "user");
    }
    const previousOwnerIndex = prefix.indexOf(previous.owner);
    const laterUsers = prefix
      .slice(previousOwnerIndex + 1)
      .filter((message) => message.role === "user");
    // A checkpoint-only window replaces its prefix; a retained-user window extends it.
    return previous.mode === "retained-users"
      ? [...collectRetainedUserMessages(prefix.slice(0, previousOwnerIndex)), ...laterUsers]
      : laterUsers;
  };
  const retainedMessages =
    compaction.mode === "retained-users"
      ? collectRetainedUserMessages(messages.slice(0, ownerIndex))
      : undefined;
  const owner = {
    ...compaction.owner,
    content:
      compaction.mode === "retained-users"
        ? []
        : compaction.owner.content.slice(compaction.replayIndex),
  };
  // Slice before transcript repair so compacted calls cannot synthesize outputs,
  // while real results emitted after the checkpoint remain in chronological order.
  return {
    messages: [owner, ...messages.slice(ownerIndex + 1)],
    ...(retainedMessages?.length ? { retainedMessages } : {}),
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
