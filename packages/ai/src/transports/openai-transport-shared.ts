import type {
  AssistantMessage,
  Model,
  OpenAICompletionsCompat,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { getAiTransportHost } from "../host.js";
import { applyProviderReportedUsageCost, calculateCost } from "../model-utils.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
/** Shared options, usage shape, cache identity, ordering, and stream scheduling for OpenAI APIs. */
import { clampOpenAIPromptCacheKey } from "../providers/openai-prompt-cache.js";
import { headersToRecord } from "../utils/headers.js";
import { notifyProviderHttpMetadata, transportAbortError } from "./transport-stream-shared.js";

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

export type OpenAICompletionsTextSource = "reasoning_detail" | "refusal";

export type OpenAICompletionsContentDelta =
  | { kind: "thinking"; signature?: string; text: string }
  | { kind: "text"; text: string; source?: OpenAICompletionsTextSource };

type OpenAICompletionsReasoningBatch = {
  readonly deltas: readonly OpenAICompletionsContentDelta[];
  readonly mirroredThinking: readonly string[];
  readonly hasThinking: boolean;
  readonly hasVisibleText: boolean;
};

type MutableOpenAICompletionsReasoningBatch = {
  deltas: OpenAICompletionsContentDelta[];
  mirroredThinking: string[];
  hasThinking: boolean;
  hasVisibleText: boolean;
};

const EMPTY_OPENAI_COMPLETIONS_REASONING_BATCH: OpenAICompletionsReasoningBatch = {
  deltas: [],
  mirroredThinking: [],
  hasThinking: false,
  hasVisibleText: false,
};

const OPENAI_COMPLETIONS_REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

function appendOpenAICompletionsReasoningDelta(
  batch: MutableOpenAICompletionsReasoningBatch,
  next: OpenAICompletionsContentDelta,
): void {
  if (next.kind === "thinking") {
    batch.hasThinking = true;
  } else {
    batch.hasVisibleText = true;
  }
  const previous = batch.deltas[batch.deltas.length - 1];
  if (!previous || previous.kind !== next.kind) {
    batch.deltas.push(next);
    if (next.kind === "thinking") {
      batch.mirroredThinking.push(next.text);
    }
    return;
  }
  if (next.kind === "thinking" && previous.kind === "thinking") {
    if (previous.signature !== next.signature) {
      batch.deltas.push(next);
      batch.mirroredThinking.push(next.text);
      return;
    }
    previous.text += next.text;
    batch.mirroredThinking[batch.mirroredThinking.length - 1] += next.text;
    return;
  }
  previous.text += next.text;
}

function createOpenAICompletionsReasoningBatch(): MutableOpenAICompletionsReasoningBatch {
  return {
    deltas: [],
    mirroredThinking: [],
    hasThinking: false,
    hasVisibleText: false,
  };
}

export function readOpenAICompletionsReasoningBatch(
  delta: Record<string, unknown>,
  visibleReasoningDetailTypes: ReadonlySet<string>,
): OpenAICompletionsReasoningBatch {
  let batch: MutableOpenAICompletionsReasoningBatch | undefined;
  const reasoningDetails = delta.reasoning_details;
  let usedReasoningThinkingDetails = false;
  if (Array.isArray(reasoningDetails)) {
    for (const item of reasoningDetails) {
      if (!isRecord(item)) {
        continue;
      }
      const detail = item;
      if (typeof detail.text !== "string" || !detail.text) {
        continue;
      }
      if (detail.type === "reasoning.text") {
        usedReasoningThinkingDetails = true;
        batch ??= createOpenAICompletionsReasoningBatch();
        appendOpenAICompletionsReasoningDelta(batch, {
          kind: "thinking",
          signature: "reasoning_details",
          text: detail.text,
        });
        continue;
      }
      // Compat-classified visible details are explicit output items. Preserve
      // their order with adjacent structured thinking instead of inferring commentary.
      if (typeof detail.type === "string" && visibleReasoningDetailTypes.has(detail.type)) {
        batch ??= createOpenAICompletionsReasoningBatch();
        appendOpenAICompletionsReasoningDelta(batch, {
          kind: "text",
          text: detail.text,
          source: "reasoning_detail",
        });
      }
    }
  }
  if (!usedReasoningThinkingDetails) {
    for (const field of OPENAI_COMPLETIONS_REASONING_FIELDS) {
      const value = delta[field];
      if (typeof value === "string" && value.length > 0) {
        batch ??= createOpenAICompletionsReasoningBatch();
        appendOpenAICompletionsReasoningDelta(batch, {
          kind: "thinking",
          signature: field,
          text: value,
        });
        break;
      }
    }
  }
  return batch ?? EMPTY_OPENAI_COMPLETIONS_REASONING_BATCH;
}

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

type MutableToolCall = ToolCall & { partialArgs?: string };

export type MutableAssistantOutput = Omit<AssistantMessage, "content" | "usage"> & {
  content: Array<TextContent | ThinkingContent | MutableToolCall>;
  usage: Usage & {
    reasoningTokens?: number;
  };
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

export function createOpenAIResponseHook(
  onResponse: BaseOpenAIStreamOptions["onResponse"],
  response: Response,
  model: Model,
): (() => void | Promise<void>) | undefined {
  return onResponse
    ? () =>
        onResponse({ status: response.status, headers: headersToRecord(response.headers) }, model)
    : undefined;
}

export function createOpenAIProviderAcceptanceHook(
  options: Pick<BaseOpenAIStreamOptions, "onProviderAccepted" | "onResponse"> | undefined,
  response: Response,
  model: Model,
): (() => void | Promise<void>) | undefined {
  if (!options?.onProviderAccepted) {
    return createOpenAIResponseHook(options?.onResponse, response, model);
  }
  return () =>
    notifyProviderHttpMetadata({
      options,
      response: { status: response.status, headers: headersToRecord(response.headers) },
      model,
    });
}

type ModelStreamCooperativeScheduler = {
  afterEvent: () => Promise<void>;
};

export function throwIfModelStreamAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw transportAbortError(signal);
  }
}

/** Measure one UTF-8 append without double-counting a surrogate pair split across chunks. */
export function measureUtf8AppendBytes(bufferEndsWithHighSurrogate: boolean, chunk: string) {
  let bytes = Buffer.byteLength(chunk, "utf8");
  if (!chunk) {
    return { bytes, endsWithHighSurrogate: bufferEndsWithHighSurrogate };
  }
  const nextCodeUnit = chunk.charCodeAt(0);
  if (bufferEndsWithHighSurrogate && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    // Each isolated surrogate counts as three UTF-8 bytes; the joined scalar is four.
    bytes -= 2;
  }
  const finalCodeUnit = chunk.charCodeAt(chunk.length - 1);
  return {
    bytes,
    endsWithHighSurrogate: finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff,
  };
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
