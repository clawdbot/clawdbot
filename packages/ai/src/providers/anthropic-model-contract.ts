// Model-bound thinking cannot be exposed or replayed after a model switch.
import {
  requiresClaudeDefaultSampling,
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeNativeThinkingLevelMap,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "@openclaw/llm-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { clampThinkingLevel } from "../model-utils.js";
import type { AnthropicEffort } from "../provider-options.js";
import type {
  Context,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  StopReason,
} from "../types.js";
export {
  requiresClaudeDefaultSampling,
  requiresClaudeMandatoryAdaptiveThinking,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeNativeThinkingLevelMap,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "@openclaw/llm-core";

export const ANTHROPIC_CLAUDE_CODE_VERSION = "2.1.75";
export const ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK = `x-anthropic-billing-header: cc_version=${ANTHROPIC_CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli;`;

type ReplayModelRef = {
  provider?: string;
  api?: string;
  modelId?: string;
  responseModelId?: string;
  modelParams?: Record<string, unknown>;
};

function normalizeModelId(modelId?: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  const unprefixed = normalized.startsWith("anthropic/")
    ? normalized.slice("anthropic/".length)
    : normalized;
  return unprefixed.replace(/[._\s]+/g, "-");
}

function normalizeApi(api?: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(api);
  return normalized === "openclaw-anthropic-messages-transport" ? "anthropic-messages" : normalized;
}

function hasConcreteResponseModel(ref: ReplayModelRef): boolean {
  const responseModelId = normalizeModelId(ref.responseModelId);
  // Deployment APIs may echo the requested alias. Only a different response
  // model proves the backing identity and overrides configured metadata.
  return responseModelId.length > 0 && responseModelId !== normalizeModelId(ref.modelId);
}

export function usesClaudeFable5MessagesContract(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  return (
    normalizeApi(model.api) === "anthropic-messages" &&
    resolveClaudeFable5ModelIdentity(model) !== undefined
  );
}

/** Return whether streamed output must wait for the terminal refusal decision. */
export function usesClaudeStreamingRefusalContract(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  if (normalizeApi(model.api) !== "anthropic-messages") {
    return false;
  }
  return (
    resolveClaudeFable5ModelIdentity(model) !== undefined ||
    resolveClaudeMythos5ModelIdentity(model) !== undefined ||
    resolveClaudeOpus5ModelIdentity(model) !== undefined ||
    resolveClaudeSonnet5ModelIdentity(model) !== undefined
  );
}

export function requiresClaudeAdaptiveThinking(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  if (normalizeApi(model.api) !== "anthropic-messages") {
    return false;
  }
  return requiresClaudeMandatoryAdaptiveThinking(model);
}

/** Return whether omitted thinking should default to adaptive/high. */
export function defaultsClaudeAdaptiveThinking(model: {
  id?: string;
  params?: Record<string, unknown>;
  api?: string;
}): boolean {
  return (
    requiresClaudeAdaptiveThinking(model) ||
    (normalizeApi(model.api) === "anthropic-messages" &&
      (resolveClaudeOpus5ModelIdentity(model) !== undefined ||
        resolveClaudeSonnet5ModelIdentity(model) !== undefined))
  );
}

/** Resolve provider-native effort once for direct and managed Claude requests. */
export function resolveAnthropicThinkingEffort(
  model: Model<"anthropic-messages">,
  level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
  const requestedLevel = level as ModelThinkingLevel | undefined;
  const thinkingLevelMap = resolveClaudeNativeThinkingLevelMap(model);
  const clampModel = {
    ...model,
    ...(typeof model.params?.canonicalModelId === "string" ? { reasoning: true } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
  const resolvedLevel = requestedLevel ? clampThinkingLevel(clampModel, requestedLevel) : undefined;
  const mapped = resolvedLevel ? thinkingLevelMap?.[resolvedLevel] : undefined;
  if (typeof mapped === "string") {
    return mapped as AnthropicEffort;
  }
  switch (resolvedLevel) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "xhigh":
      return supportsClaudeNativeXhighEffort(model) ? "xhigh" : "high";
    case "max":
      return supportsClaudeNativeMaxEffort(model) ? "max" : "high";
    default:
      return "high";
  }
}

/** Normalize Anthropic and Anthropic-compatible terminal reasons identically. */
export function mapAnthropicStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "compaction":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
    case "sensitive":
      return "error";
    default:
      throw new Error(`Unhandled stop reason: ${String(reason)}`);
  }
}

/** Remove unsupported assistant prefills while preserving completed tool-use turns. */
export function prepareClaudeNoPrefillRequestContext(model: Model, context: Context): Context {
  if (!resolveClaudeOpus5ModelIdentity(model) && !resolveClaudeSonnet5ModelIdentity(model)) {
    return context;
  }

  let end = context.messages.length;
  while (end > 0) {
    const message = context.messages[end - 1];
    if (
      message?.role !== "assistant" ||
      (Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall"))
    ) {
      break;
    }
    end -= 1;
  }
  return end === context.messages.length
    ? context
    : { ...context, messages: context.messages.slice(0, end) };
}

type ClaudeSamplingRequestParams = {
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  service_tier?: unknown;
};

export function applyClaudeRequestContract(
  params: ClaudeSamplingRequestParams,
  model: {
    id?: string;
    params?: Record<string, unknown>;
    api?: string;
  },
): void {
  if (normalizeApi(model.api) !== "anthropic-messages") {
    return;
  }
  const opus5 = resolveClaudeOpus5ModelIdentity(model) !== undefined;
  const sonnet5 = resolveClaudeSonnet5ModelIdentity(model) !== undefined;
  if (!requiresClaudeDefaultSampling(model) && !opus5 && !sonnet5) {
    return;
  }
  delete params.temperature;
  delete params.top_p;
  delete params.top_k;
  if (opus5 || sonnet5) {
    delete params.service_tier;
  }
}

function resolveReplayModelBoundIdentity(ref: ReplayModelRef): string | undefined {
  if (normalizeApi(ref.api) !== "anthropic-messages") {
    return undefined;
  }
  const modelRef = hasConcreteResponseModel(ref)
    ? { id: ref.responseModelId }
    : { id: ref.modelId, params: ref.modelParams };
  const fableIdentity = resolveClaudeFable5ModelIdentity(modelRef);
  if (fableIdentity) {
    return `fable:${fableIdentity}`;
  }
  const mythosIdentity = resolveClaudeMythos5ModelIdentity(modelRef);
  if (mythosIdentity) {
    return `mythos:${mythosIdentity}`;
  }
  const opusIdentity = resolveClaudeOpus5ModelIdentity(modelRef);
  if (opusIdentity) {
    return `opus:${opusIdentity}`;
  }
  const sonnetIdentity = resolveClaudeSonnet5ModelIdentity(modelRef);
  return sonnetIdentity ? `sonnet:${sonnetIdentity}` : undefined;
}

export function resolveModelBoundThinkingReplayMode(params: {
  source: ReplayModelRef;
  target: ReplayModelRef;
}): "default" | "preserve" | "drop" {
  const sourceApi = normalizeApi(params.source.api);
  const targetApi = normalizeApi(params.target.api);
  const sourceIdentity = resolveReplayModelBoundIdentity(params.source);
  const targetIdentity = resolveReplayModelBoundIdentity(params.target);
  const sameRoute =
    normalizeLowercaseStringOrEmpty(params.source.provider) ===
      normalizeLowercaseStringOrEmpty(params.target.provider) &&
    sourceApi === targetApi &&
    normalizeModelId(params.source.modelId) === normalizeModelId(params.target.modelId);
  if (!sourceIdentity && !targetIdentity) {
    return "default";
  }
  if (!sourceIdentity && !hasConcreteResponseModel(params.source) && targetIdentity && sameRoute) {
    return "preserve";
  }
  const sameModel = sourceApi === targetApi && sourceIdentity === targetIdentity;
  return sameModel ? "preserve" : "drop";
}
