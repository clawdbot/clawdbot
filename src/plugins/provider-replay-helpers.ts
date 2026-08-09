// Provides shared replay-policy helpers for provider plugins.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../agents/runtime/index.js";
import { sanitizeGoogleAssistantFirstOrdering } from "../shared/google-turn-ordering.js";
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
    repairToolUseResultPairing: true,
    validateAnthropicTurns: true,
    allowSyntheticToolResults: true,
    ...(options.dropThinkingBlocks ? { dropThinkingBlocks: true } : {}),
  };
}

/**
 * Returns true for Claude models that preserve thinking blocks in context
 * natively (generation 4 and newer). For these models, dropping thinking blocks
 * from prior turns breaks replay and prompt caching.
 *
 * See: https://platform.claude.com/docs/en/build-with-claude/extended-thinking#differences-in-thinking-across-model-versions
 *
 * @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks.
 */
export function shouldPreserveThinkingBlocks(modelId?: string): boolean {
  const id = normalizeLowercaseStringOrEmpty(modelId);
  if (!id.includes("claude")) {
    return false;
  }

  // Claude 4 and newer preserve thinking blocks natively; 3.x and earlier must drop them.
  // The generation follows the family for current ids (claude-opus-5, claude-sonnet-4-6) but
  // precedes it for legacy ones (claude-3-7-sonnet), so skip any family segment before reading it.
  const generation = id.match(/claude-[a-z-]*?(\d+)/)?.[1];
  return generation !== undefined && Number(generation) >= 4;
}

/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export function buildAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy {
  const isClaude = normalizeLowercaseStringOrEmpty(modelId).includes("claude");
  return buildStrictAnthropicReplayPolicy({
    dropThinkingBlocks: isClaude && !shouldPreserveThinkingBlocks(modelId),
  });
}

/** @deprecated Anthropic-family provider replay helper; prefer provider-local replay hooks. */
export function buildNativeAnthropicReplayPolicyForModel(modelId?: string): ProviderReplayPolicy {
  const isClaude = normalizeLowercaseStringOrEmpty(modelId).includes("claude");
  return buildStrictAnthropicReplayPolicy({
    dropThinkingBlocks: isClaude && !shouldPreserveThinkingBlocks(modelId),
    sanitizeToolCallIds: true,
    preserveNativeAnthropicToolUseIds: true,
  });
}

/** @deprecated Provider replay helper; prefer provider-local replay hooks. */
export function buildHybridAnthropicOrOpenAIReplayPolicy(
  ctx: ProviderReplayPolicyContext,
  options: { anthropicModelDropThinkingBlocks?: boolean } = {},
): ProviderReplayPolicy | undefined {
  if (ctx.modelApi === "anthropic-messages" || ctx.modelApi === "bedrock-converse-stream") {
    const isClaude = normalizeLowercaseStringOrEmpty(ctx.modelId).includes("claude");
    return buildStrictAnthropicReplayPolicy({
      dropThinkingBlocks:
        options.anthropicModelDropThinkingBlocks &&
        isClaude &&
        !shouldPreserveThinkingBlocks(ctx.modelId),
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
