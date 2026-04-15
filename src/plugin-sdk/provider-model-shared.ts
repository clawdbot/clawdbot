import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderSanitizeReplayHistoryContext,
} from "../plugins/types.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { ProviderPlugin } from "../plugins/types.js";

export * from "./provider-models.js";
export type { ModelApi, ModelDefinitionConfig, ModelProviderConfig, ProviderPlugin };
export type { KilocodeModelCatalogEntry } from "../providers/kilocode-shared.js";

type ReplayHooks = Pick<
  ProviderPlugin,
  "buildReplayPolicy" | "resolveReasoningOutputMode" | "sanitizeReplayHistory"
>;

type ReplayFamily =
  | "openai-compatible"
  | "native-anthropic"
  | "passthrough-gemini"
  | "google-gemini"
  | "hybrid-anthropic-openai";

function buildOpenAiCompatibleReplayPolicy(
  ctx: ProviderReplayPolicyContext,
  options?: {
    validateGeminiTurns?: boolean;
    validateAnthropicTurns?: boolean;
    applyAssistantFirstOrderingFix?: boolean;
    anthropicModelDropThinkingBlocks?: boolean;
  },
): ProviderReplayPolicy {
  const isResponsesApi =
    ctx.modelApi === "openai-responses" || ctx.modelApi === "openai-codex-responses";
  const sanitizeToolCallIds = true;
  return {
    sanitizeMode: "images-only",
    sanitizeToolCallIds,
    ...(sanitizeToolCallIds ? { toolCallIdMode: "strict" as const } : {}),
    applyAssistantFirstOrderingFix:
      options?.applyAssistantFirstOrderingFix ?? (isResponsesApi ? false : true),
    validateGeminiTurns: options?.validateGeminiTurns ?? !isResponsesApi,
    validateAnthropicTurns: options?.validateAnthropicTurns ?? !isResponsesApi,
    ...(options?.anthropicModelDropThinkingBlocks
      ? { anthropicModelDropThinkingBlocks: true }
      : {}),
  };
}

function buildNativeAnthropicReplayPolicy(): ProviderReplayPolicy {
  return {
    sanitizeMode: "full",
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    preserveNativeAnthropicToolUseIds: true,
    preserveSignatures: true,
    repairToolUseResultPairing: true,
    validateAnthropicTurns: true,
    allowSyntheticToolResults: true,
  };
}

function buildGoogleGeminiReplayPolicy(): ProviderReplayPolicy {
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

async function sanitizeGoogleReplayHistory(
  ctx: ProviderSanitizeReplayHistoryContext,
): Promise<ProviderSanitizeReplayHistoryContext["messages"]> {
  const firstMessage = ctx.messages[0];
  if (firstMessage?.role !== "assistant") {
    return ctx.messages;
  }
  ctx.sessionState.appendCustomEntry?.("google-turn-ordering-bootstrap", {
    provider: ctx.provider,
    modelId: ctx.modelId,
  });
  return [
    {
      role: "user",
      content: "(session bootstrap)",
    } as (typeof ctx.messages)[number],
    ...ctx.messages,
  ];
}

export function matchesExactOrPrefix(modelId: string, ids: readonly string[]): boolean {
  const normalizedModelId = modelId.trim().toLowerCase();
  return ids.some((candidate) => {
    const normalizedCandidate = candidate.trim().toLowerCase();
    return (
      normalizedModelId === normalizedCandidate ||
      normalizedModelId.startsWith(`${normalizedCandidate}-`) ||
      normalizedModelId.startsWith(`${normalizedCandidate}/`)
    );
  });
}

export function buildProviderReplayFamilyHooks(params: {
  family: ReplayFamily;
  anthropicModelDropThinkingBlocks?: boolean;
}): ReplayHooks {
  switch (params.family) {
    case "native-anthropic":
      return {
        buildReplayPolicy: () => buildNativeAnthropicReplayPolicy(),
        resolveReasoningOutputMode: () => "native",
      };
    case "google-gemini":
      return {
        buildReplayPolicy: () => buildGoogleGeminiReplayPolicy(),
        resolveReasoningOutputMode: () => "tagged",
        sanitizeReplayHistory: sanitizeGoogleReplayHistory,
      };
    case "hybrid-anthropic-openai":
      return {
        buildReplayPolicy: (ctx) =>
          buildOpenAiCompatibleReplayPolicy(ctx, {
            validateGeminiTurns: true,
            validateAnthropicTurns: true,
            applyAssistantFirstOrderingFix: true,
            anthropicModelDropThinkingBlocks: params.anthropicModelDropThinkingBlocks,
          }),
        resolveReasoningOutputMode: () => "native",
      };
    case "passthrough-gemini":
      return {
        buildReplayPolicy: (ctx) =>
          buildOpenAiCompatibleReplayPolicy(ctx, {
            validateGeminiTurns: true,
            validateAnthropicTurns: false,
          }),
        resolveReasoningOutputMode: () => "native",
      };
    case "openai-compatible":
    default:
      return {
        buildReplayPolicy: (ctx) => buildOpenAiCompatibleReplayPolicy(ctx),
      };
  }
}

export const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

export const NATIVE_ANTHROPIC_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "native-anthropic",
});

export const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});

export { normalizeProviderId };
