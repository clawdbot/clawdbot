// Provides shared replay-policy helpers for provider plugins.
import {
  bindsClaudeThinkingPrefix,
  resolveClaudeModelIdentity,
  resolveClaudeOpus5ModelIdentity,
} from "@openclaw/llm-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../agents/runtime/index.js";
import { sanitizeGoogleAssistantFirstOrdering } from "../shared/google-turn-ordering.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type {
  ProviderReasoningOutputMode,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderReplaySessionState,
  ProviderSanitizeReplayHistoryContext,
} from "./types.js";

/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
export function buildOpenAICompatibleReplayPolicy(
  modelApi: string | null | undefined,
  options: {
    sanitizeToolCallIds?: boolean;
    duplicateToolCallIdStyle?: "openai";
    modelId?: string | null;
    dropReasoningFromHistory?: boolean;
  } = {},
): ProviderReplayPolicy | undefined {
  if (
    modelApi !== "openai-completions" &&
    modelApi !== "openai-responses" &&
    modelApi !== "openai-chatgpt-responses" &&
    modelApi !== "azure-openai-responses"
  ) {
    return undefined;
  }

  const sanitizeToolCallIds = options.sanitizeToolCallIds ?? true;
  const dropReasoningFromHistory = options.dropReasoningFromHistory ?? true;
  const isResponsesFamily =
    modelApi === "openai-responses" ||
    modelApi === "openai-chatgpt-responses" ||
    modelApi === "azure-openai-responses";

  return {
    ...(sanitizeToolCallIds
      ? {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict" as const,
          ...(options.duplicateToolCallIdStyle
            ? { duplicateToolCallIdStyle: options.duplicateToolCallIdStyle }
            : {}),
        }
      : {}),
    ...(isResponsesFamily ? { allowSyntheticToolResults: true } : {}),
    ...(modelApi === "openai-completions"
      ? {
          applyAssistantFirstOrderingFix: true,
          validateGeminiTurns: true,
          validateAnthropicTurns: true,
        }
      : {
          applyAssistantFirstOrderingFix: false,
          validateGeminiTurns: false,
          validateAnthropicTurns: false,
        }),
    ...(modelApi === "openai-completions" && dropReasoningFromHistory
      ? { dropReasoningFromHistory: true }
      : {}),
  };
}

/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export function buildStrictAnthropicReplayPolicy(
  options: {
    dropThinkingBlocks?: boolean;
    appendOnlyRuntimeContext?: boolean;
    sanitizeToolCallIds?: boolean;
    preserveNativeAnthropicToolUseIds?: boolean;
  } = {},
): ProviderReplayPolicy {
  const sanitizeToolCallIds = options.sanitizeToolCallIds ?? true;
  return {
    sanitizeMode: "full",
    ...(sanitizeToolCallIds
      ? {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict" as const,
          ...(options.preserveNativeAnthropicToolUseIds
            ? { preserveNativeAnthropicToolUseIds: true }
            : {}),
        }
      : {}),
    preserveSignatures: true,
    appendOnlyRuntimeContext: options.appendOnlyRuntimeContext ?? false,
    repairToolUseResultPairing: true,
    validateAnthropicTurns: true,
    allowSyntheticToolResults: true,
    ...(options.dropThinkingBlocks ? { dropThinkingBlocks: true } : {}),
  };
}

/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export function shouldDropClaudeThinkingBlocks(
  modelId?: string,
  model?: Pick<ProviderRuntimeModel, "params">,
): boolean {
  const ref = { id: modelId, params: model?.params };
  const canonicalId = resolveClaudeModelIdentity(ref);
  const isClaude =
    canonicalId.startsWith("claude-") || resolveClaudeOpus5ModelIdentity(ref) !== undefined;
  const preservesThinking =
    resolveClaudeOpus5ModelIdentity(ref) !== undefined ||
    /(?:^|-)claude-(?:fable-5|mythos-(?:5|preview)|opus-4-(?:5|6|7|8)|sonnet-(?:5|4-6))(?=$|[^a-z0-9])/.test(
      canonicalId,
    );
  return isClaude && !preservesThinking;
}

/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export function buildAnthropicReplayPolicyForModel(
  modelId?: string,
  model?: Pick<ProviderRuntimeModel, "params">,
): ProviderReplayPolicy {
  return buildStrictAnthropicReplayPolicy({
    dropThinkingBlocks: shouldDropClaudeThinkingBlocks(modelId, model),
    appendOnlyRuntimeContext: bindsClaudeThinkingPrefix({ id: modelId, params: model?.params }),
  });
}

/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export function buildNativeAnthropicReplayPolicyForModel(
  modelId?: string,
  model?: Pick<ProviderRuntimeModel, "params">,
): ProviderReplayPolicy {
  return {
    ...buildAnthropicReplayPolicyForModel(modelId, model),
    preserveNativeAnthropicToolUseIds: true,
  };
}

/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
export function buildHybridAnthropicOrOpenAIReplayPolicy(
  ctx: ProviderReplayPolicyContext,
  options: { anthropicModelDropThinkingBlocks?: boolean } = {},
): ProviderReplayPolicy | undefined {
  if (ctx.modelApi === "anthropic-messages" || ctx.modelApi === "bedrock-converse-stream") {
    return buildStrictAnthropicReplayPolicy({
      appendOnlyRuntimeContext: bindsClaudeThinkingPrefix({
        id: ctx.modelId,
        params: ctx.model?.params,
      }),
      dropThinkingBlocks:
        options.anthropicModelDropThinkingBlocks &&
        shouldDropClaudeThinkingBlocks(ctx.modelId, ctx.model),
    });
  }

  return buildOpenAICompatibleReplayPolicy(ctx.modelApi, { modelId: ctx.modelId });
}

const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";

function hasGoogleTurnOrderingMarker(sessionState: ProviderReplaySessionState): boolean {
  return sessionState
    .getCustomEntries()
    .some((entry) => entry.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE);
}

function markGoogleTurnOrderingMarker(sessionState: ProviderReplaySessionState): void {
  sessionState.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
    timestamp: Date.now(),
  });
}

/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
export function buildGoogleGeminiReplayPolicy(): ProviderReplayPolicy {
  return {
    // Managed explicit caching projects the current volatile system suffix here.
    appendOnlyRuntimeContext: false,
    sanitizeMode: "full",
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    sanitizeThoughtSignatures: {
      allowBase64Only: true,
      includeCamelCase: true,
    },
    repairToolUseResultPairing: true,
    applyAssistantFirstOrderingFix: true,
    validateGeminiTurns: true,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: true,
  };
}

/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
export function buildPassthroughGeminiSanitizingReplayPolicy(
  modelId?: string,
): ProviderReplayPolicy {
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  return {
    applyAssistantFirstOrderingFix: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    ...(normalizedModelId.includes("gemini")
      ? {
          sanitizeThoughtSignatures: {
            allowBase64Only: true,
            includeCamelCase: true,
          },
        }
      : {}),
  };
}

/** @deprecated Google provider replay helper; prefer provider-local replay hooks. */
export function sanitizeGoogleGeminiReplayHistory(
  ctx: ProviderSanitizeReplayHistoryContext,
): AgentMessage[] {
  const messages = sanitizeGoogleAssistantFirstOrdering(ctx.messages);
  if (
    messages !== ctx.messages &&
    ctx.sessionState &&
    !hasGoogleTurnOrderingMarker(ctx.sessionState)
  ) {
    markGoogleTurnOrderingMarker(ctx.sessionState);
  }
  return messages;
}

/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
export function resolveTaggedReasoningOutputMode(): ProviderReasoningOutputMode {
  return "tagged";
}
