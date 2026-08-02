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

export type OpenAICompletionsContentDelta =
  | { kind: "thinking"; signature?: string; text: string }
  | { kind: "text"; text: string; source?: "refusal" };

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

export function isOpenAICompletionsThinkingEnabled(effort: string): boolean {
  const normalized = effort.trim().toLowerCase();
  return normalized !== "off" && normalized !== "none";
}

export function readOpenAICompletionsContentDeltas(
  content: unknown,
  topLevelRefusal?: unknown,
  mirroredThinking: readonly string[] = [],
): OpenAICompletionsContentDelta[] {
  let deltas = readOpenAICompletionsContentPartDeltas(content);
  if (mirroredThinking.length > 0) {
    const structuredThinking = deltas
      .filter((delta) => delta.kind === "thinking")
      .map((delta) => delta.text);
    const mirrorsCombinedThinking =
      structuredThinking.length > 1 && mirroredThinking.includes(structuredThinking.join(""));
    // Suppress exact same-chunk mirrors, not independent structured thoughts.
    deltas = deltas.filter(
      (delta) =>
        delta.kind !== "thinking" ||
        (!mirrorsCombinedThinking && !mirroredThinking.includes(delta.text)),
    );
  }
  if (typeof topLevelRefusal !== "string" || !topLevelRefusal) {
    return deltas;
  }
  const structuredRefusals = deltas
    .filter((delta) => delta.kind === "text" && delta.source === "refusal")
    .map((delta) => delta.text);
  // Compatible providers may mirror one refusal as parts and a top-level field;
  // suppress only that exact duplicate, never distinct text or later chunks.
  if (
    structuredRefusals.some((refusal) => refusal === topLevelRefusal) ||
    (structuredRefusals.length > 1 && structuredRefusals.join("") === topLevelRefusal)
  ) {
    return deltas;
  }
  return [...deltas, { kind: "text", text: topLevelRefusal, source: "refusal" }];
}

function readOpenAICompletionsContentPartDeltas(content: unknown): OpenAICompletionsContentDelta[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.flatMap(readOpenAICompletionsContentPartDeltas);
  }
  if (!content || typeof content !== "object") {
    return [];
  }
  const record = content as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  // Compatible providers stream typed objects; direct coercion persists them
  // as "[object Object]" instead of preserving visible text and reasoning.
  const extractText = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(extractText).join("");
    }
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      return extractText(nested.text ?? nested.content ?? nested.thinking ?? nested.refusal);
    }
    return "";
  };
  const text = extractText(record.text ?? record.content ?? record.thinking ?? record.refusal);
  if (!text) {
    return [];
  }
  // Thinking stays distinct so channel/UI policy controls its visibility.
  if (type.includes("thinking") || type.includes("reasoning")) {
    // Content parts supply no replay-field signature. Inventing "content"
    // overwrites the visible assistant answer on the next completion request.
    return [{ kind: "thinking", text }];
  }
  if (type === "refusal") {
    return [{ kind: "text", text, source: "refusal" }];
  }
  if (["text", "output_text"].includes(type) || type.endsWith(".output_text")) {
    return [{ kind: "text", text }];
  }
  return [];
}
