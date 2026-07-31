import type { Api, Model, OpenAICompletionsCompat, Usage } from "@openclaw/llm-core";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { getAiTransportHost } from "../host.js";
import { applyProviderReportedUsageCost, calculateCost } from "../model-utils.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
/** Shared options, usage shape, cache identity, ordering, and stream scheduling for OpenAI APIs. */
import { clampOpenAIPromptCacheKey } from "../providers/openai-prompt-cache.js";
import { transportAbortError } from "./transport-stream-shared.js";

export { sortPromptCacheToolsByName as sortTransportToolsByName } from "../utils/prompt-cache-stability.js";

const MODEL_STREAM_COOPERATIVE_YIELD_INTERVAL_MS = 12;
const MODEL_STREAM_COOPERATIVE_YIELD_MAX_EVENTS = 64;

export const GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP = "skip_thought_signature_validator";
export const log = {
  debug(message: string, data?: Record<string, unknown>) {
    getAiTransportHost().logDebug("openai-transport", () => ({ message, data }));
  },
  info(message: string, data?: Record<string, unknown>) {
    getAiTransportHost().logInfo("openai-transport", message, data);
  },
  warn(message: string, data?: Record<string, unknown>) {
    getAiTransportHost().logWarn("openai-transport", message, data);
  },
};

export type { OpenAICompletionsOptions } from "../provider-options.js";

type OpenAIModeCompatInput = Omit<OpenAICompletionsCompat, "thinkingFormat"> & {
  thinkingFormat?: string;
  requiresStringContent?: boolean;
  strictMessageKeys?: boolean;
  unsupportedToolSchemaKeywords?: unknown;
  omitEmptyArrayItems?: unknown;
  visibleReasoningDetailTypes?: string[];
};

export type OpenAIModeModel = Omit<Model, "compat"> & {
  compat?: OpenAIModeCompatInput | null;
};

export type MutableAssistantOutput = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  api: Api;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoningTokens?: number;
    totalTokens: number;
    cost: Usage["cost"];
  };
  stopReason: string;
  timestamp: number;
  responseId?: string;
  errorMessage?: string;
  errorCode?: string;
  errorType?: string;
  errorBody?: string;
};

export function parseOpenAICompletionsUsage(
  rawUsage: NonNullable<ChatCompletionChunk["usage"]> & {
    cost?: unknown;
    prompt_cache_hit_tokens?: number;
  },
  model: Model,
  options?: { includeReasoningTokens?: boolean },
): MutableAssistantOutput["usage"] {
  const cacheRead =
    rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
  const cacheWrite = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
  const input = Math.max(0, (rawUsage.prompt_tokens || 0) - cacheRead - cacheWrite);
  const output = rawUsage.completion_tokens || 0;
  const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
  const usage: MutableAssistantOutput["usage"] = {
    input,
    output,
    cacheRead,
    cacheWrite,
    // Managed transport exposes reasoning telemetry; the shipped package Usage shape does not.
    ...(options?.includeReasoningTokens !== false &&
    typeof reasoningTokens === "number" &&
    Number.isFinite(reasoningTokens)
      ? { reasoningTokens }
      : {}),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  applyProviderReportedUsageCost(usage, rawUsage.cost);
  return usage;
}

type ModelStreamCooperativeScheduler = {
  afterEvent: () => Promise<void>;
};

export function throwIfModelStreamAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw transportAbortError(signal);
  }
}

export function createModelStreamCooperativeScheduler(
  signal?: AbortSignal,
): ModelStreamCooperativeScheduler {
  let lastYieldedAt = Date.now();
  let eventsSinceYield = 0;
  return {
    async afterEvent() {
      throwIfModelStreamAborted(signal);
      eventsSinceYield += 1;
      const now = Date.now();
      if (
        eventsSinceYield < MODEL_STREAM_COOPERATIVE_YIELD_MAX_EVENTS &&
        now - lastYieldedAt < MODEL_STREAM_COOPERATIVE_YIELD_INTERVAL_MS
      ) {
        return;
      }
      eventsSinceYield = 0;
      lastYieldedAt = now;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      throwIfModelStreamAborted(signal);
    },
  };
}

export function resolvePromptCacheKey(
  options: Pick<BaseOpenAIStreamOptions, "promptCacheKey" | "sessionId"> | undefined,
  cacheRetention: "short" | "long" | "none",
): string | undefined {
  if (cacheRetention === "none") {
    return undefined;
  }
  return clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}
