import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { shortHash } from "../utils/hash.js";
import { providerReplayContextMatches } from "./provider-replay-context.js";

const ANTHROPIC_COMPACTION_REPLAY_TYPE = "anthropic-compaction";
const ANTHROPIC_COMPACTION_SUPPRESSION_TYPE = "anthropic-compaction-suppression";
const ANTHROPIC_COMPACTION_SUPPRESSION_DATA = "rejected";

type AnthropicReplayContext = {
  provider: string;
  api: Model["api"];
  model: string;
  baseUrlHash?: string;
  sessionHash?: string;
  authProfileHash?: string;
};

type AnthropicCompactionReplayState = ProviderReplayState & {
  type: typeof ANTHROPIC_COMPACTION_REPLAY_TYPE;
  baseUrlHash: string;
};

type AnthropicCompactionSuppressionState = ProviderReplayState & {
  type: typeof ANTHROPIC_COMPACTION_SUPPRESSION_TYPE;
  data: typeof ANTHROPIC_COMPACTION_SUPPRESSION_DATA;
  baseUrlHash: string;
};

export type AnthropicCompactionBlock = {
  type: "compaction";
  content: string;
};

type AnthropicCompactionReplayPlan = {
  messages: Context["messages"];
  compaction?: AnthropicCompactionBlock;
};

type ReplayOpts = { authProfileId?: string; sessionId?: string };
type ReplayOut = Pick<AssistantMessage, "providerReplay">;

export function createCompactionCapture(output: ReplayOut, model: Model, options?: ReplayOpts) {
  const pending = new Map<number, { content: string; replayIndex: number }>();
  return {
    begin(index: number, block: Record<string, unknown> | undefined, replayIndex: number): boolean {
      if (block?.type !== "compaction") {
        return false;
      }
      const content = typeof block.content === "string" ? block.content : "";
      pending.set(index, { content, replayIndex });
      return true;
    },
    delta(index: number, delta: Record<string, unknown> | undefined): boolean {
      const capture = pending.get(index);
      if (!capture || delta?.type !== "compaction_delta") {
        return false;
      }
      capture.content = typeof delta.content === "string" ? delta.content : capture.content;
      return true;
    },
    complete(index: number): boolean {
      const capture = pending.get(index);
      if (!capture) {
        return false;
      }
      pending.delete(index);
      captureAnthropicCompaction(output, capture.content, capture.replayIndex, model, options);
      return true;
    },
  };
}

function hashReplayValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

function buildAnthropicReplayContext(model: Model, options?: ReplayOpts): AnthropicReplayContext {
  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrlHash: hashReplayValue(model.baseUrl),
    sessionHash: hashReplayValue(options?.sessionId),
    authProfileHash: hashReplayValue(options?.authProfileId),
  };
}

function isAnthropicCompactionState(
  state: Record<string, unknown>,
): state is Record<string, unknown> &
  (AnthropicCompactionReplayState | AnthropicCompactionSuppressionState) {
  if (
    state.v !== 1 ||
    typeof state.data !== "string" ||
    typeof state.provider !== "string" ||
    typeof state.api !== "string" ||
    typeof state.model !== "string" ||
    typeof state.baseUrlHash !== "string" ||
    (state.sessionHash !== undefined && typeof state.sessionHash !== "string") ||
    (state.authProfileHash !== undefined && typeof state.authProfileHash !== "string")
  ) {
    return false;
  }
  if (state.type === ANTHROPIC_COMPACTION_SUPPRESSION_TYPE) {
    return state.data === ANTHROPIC_COMPACTION_SUPPRESSION_DATA;
  }
  return (
    state.type === ANTHROPIC_COMPACTION_REPLAY_TYPE &&
    state.data.length > 0 &&
    (state.replayIndex === undefined ||
      (typeof state.replayIndex === "number" &&
        Number.isSafeInteger(state.replayIndex) &&
        state.replayIndex >= 0))
  );
}

function readAnthropicCompactionState(
  value: unknown,
): AnthropicCompactionReplayState | AnthropicCompactionSuppressionState | undefined {
  return isRecord(value) && isAnthropicCompactionState(value) ? value : undefined;
}

function captureAnthropicCompaction(
  output: ReplayOut,
  summary: string,
  replayIndex: number,
  model: Model,
  options?: ReplayOpts,
): void {
  const context = buildAnthropicReplayContext(model, options);
  if (!summary || !context.baseUrlHash || !Number.isSafeInteger(replayIndex) || replayIndex < 0) {
    return;
  }
  output.providerReplay = {
    v: 1,
    type: ANTHROPIC_COMPACTION_REPLAY_TYPE,
    data: summary,
    replayIndex,
    ...context,
    baseUrlHash: context.baseUrlHash,
  };
}

export function suppressAnthropicCompaction(
  output: ReplayOut,
  model: Model,
  options?: ReplayOpts,
): void {
  const context = buildAnthropicReplayContext(model, options);
  if (!context.baseUrlHash) {
    return;
  }
  output.providerReplay = {
    v: 1,
    type: ANTHROPIC_COMPACTION_SUPPRESSION_TYPE,
    data: ANTHROPIC_COMPACTION_SUPPRESSION_DATA,
    ...context,
    baseUrlHash: context.baseUrlHash,
  };
}

export function resolveNewestAnthropicCompaction(
  messages: Context["messages"],
  model: Model,
  options?: ReplayOpts,
): { owner: AssistantMessage; replayIndex: number; summary: string } | undefined {
  const context = buildAnthropicReplayContext(model, options);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const replayState = readAnthropicCompactionState(message.providerReplay);
    if (replayState?.type === ANTHROPIC_COMPACTION_SUPPRESSION_TYPE) {
      if (providerReplayContextMatches(replayState, context)) {
        return undefined;
      }
      continue;
    }
    if (message.providerReplay?.type !== ANTHROPIC_COMPACTION_REPLAY_TYPE) {
      continue;
    }
    if (!replayState) {
      return undefined;
    }
    if (!providerReplayContextMatches(replayState, context)) {
      return undefined;
    }
    return {
      owner: message,
      replayIndex: replayState.replayIndex ?? 0,
      summary: replayState.data,
    };
  }
  return undefined;
}

export function buildAnthropicReplayPlan(
  messages: Context["messages"],
  model: Model,
  options?: ReplayOpts & { enabled?: boolean },
): AnthropicCompactionReplayPlan {
  if (options?.enabled !== true) {
    return { messages };
  }
  const checkpoint = resolveNewestAnthropicCompaction(messages, model, options);
  if (!checkpoint) {
    return { messages };
  }
  const ownerIndex = messages.indexOf(checkpoint.owner);
  const owner = {
    ...checkpoint.owner,
    content: checkpoint.owner.content.slice(checkpoint.replayIndex),
  };
  return {
    messages: [owner, ...messages.slice(ownerIndex + 1)],
    compaction: { type: "compaction", content: checkpoint.summary },
  };
}

/** Match Anthropic's 400 response when a replay block is no longer accepted. */
export function isAnthropicReplayRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  const text = [record.message, record.code, nested?.message, nested?.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const isBadRequest = record.status === 400 || text.startsWith("http 400:");
  return isBadRequest && (text.includes("compaction") || text.includes("context_management"));
}
