import type { Api, Model, OpenAICompletionsCompat, Usage } from "@openclaw/llm-core";
import { getAiTransportHost } from "../host.js";
/** Shared options, usage shape, cache identity, ordering, and stream scheduling for OpenAI APIs. */
import {
  clampOpenAIPromptCacheKey,
  type OpenAICompletionsToolChoice,
  type OpenAIReasoningEffort,
} from "../internal/openai.js";

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

export type BaseOpenAIStreamOptions = {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  apiKey?: string;
  cacheRetention?: "none" | "short" | "long";
  sessionId?: string;
  promptCacheKey?: string;
  authProfileId?: string;
  onPayload?: (payload: unknown, model: Model) => unknown;
  headers?: Record<string, string>;
  firstEventTimeoutMs?: number;
  onFirstEventTimeout?: (reason: Error) => void;
  openclawCodeModeToolSurface?: boolean;
  responseFormat?: Record<string, unknown>;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
};

export type OpenAICompletionsOptions = BaseOpenAIStreamOptions & {
  toolChoice?: OpenAICompletionsToolChoice;
  reasoning?: OpenAIReasoningEffort;
  reasoningEffort?: OpenAIReasoningEffort;
};

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

type ModelStreamCooperativeScheduler = {
  afterEvent: () => Promise<void>;
};

export function throwIfModelStreamAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Request was aborted");
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

export function resolveCacheRetention(
  cacheRetention: string | undefined,
): "short" | "long" | "none" {
  if (cacheRetention === "short" || cacheRetention === "long" || cacheRetention === "none") {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.OPENCLAW_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
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

function compareTransportToolText(left: string | undefined, right: string | undefined): number {
  const leftText = left ?? "";
  const rightText = right ?? "";
  if (leftText < rightText) {
    return -1;
  }
  if (leftText > rightText) {
    return 1;
  }
  return 0;
}

export function sortTransportToolsByName<T extends { name?: string; description?: string }>(
  tools: readonly T[],
): T[] {
  return tools.toSorted(
    (left, right) =>
      compareTransportToolText(left.name, right.name) ||
      compareTransportToolText(left.description, right.description),
  );
}
