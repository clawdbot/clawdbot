import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldPreserveThinkingBlocks } from "../plugins/provider-replay-helpers.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveProviderRuntimePlugin } from "../plugins/provider-runtime.js";
import type { ProviderReplayPolicy } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./model-selection.js";
import { isGoogleModelApi } from "./pi-embedded-helpers/google.js";
import type { ToolCallIdMode } from "./tool-call-id.js";

export type TranscriptSanitizeMode = "full" | "images-only";

export type TranscriptPolicy = {
  sanitizeMode: TranscriptSanitizeMode;
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  preserveNativeAnthropicToolUseIds: boolean;
  repairToolUseResultPairing: boolean;
  preserveSignatures: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  sanitizeThinkingSignatures: boolean;
  dropThinkingBlocks: boolean;
  applyGoogleTurnOrdering: boolean;
  validateGeminiTurns: boolean;
  validateAnthropicTurns: boolean;
  allowSyntheticToolResults: boolean;
};

export function shouldAllowProviderOwnedThinkingReplay(params: {
  modelApi?: string | null;
  policy: Pick<
    TranscriptPolicy,
    "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks"
  >;
}): boolean {
  return (
    isAnthropicApi(params.modelApi) &&
    params.policy.validateAnthropicTurns &&
    params.policy.preserveSignatures &&
    !params.policy.dropThinkingBlocks
  );
}

const DEFAULT_TRANSCRIPT_POLICY: TranscriptPolicy = {
  sanitizeMode: "images-only",
  sanitizeToolCallIds: false,
  toolCallIdMode: undefined,
  preserveNativeAnthropicToolUseIds: false,
  repairToolUseResultPairing: true,
  preserveSignatures: false,
  sanitizeThoughtSignatures: undefined,
  sanitizeThinkingSignatures: false,
  dropThinkingBlocks: false,
  applyGoogleTurnOrdering: false,
  validateGeminiTurns: false,
  validateAnthropicTurns: false,
  allowSyntheticToolResults: false,
};

function isAnthropicApi(modelApi?: string | null): boolean {
  return modelApi === "anthropic-messages" || modelApi === "bedrock-converse-stream";
}

/**
 * Provides a narrow replay-policy fallback for providers that do not have an
 * owning runtime plugin.
 *
 * This exists to preserve generic custom-provider behavior. Bundled providers
 * should express replay ownership through `buildReplayPolicy` instead.
 */
function buildUnownedProviderTransportReplayFallback(params: {
  modelApi?: string | null;
  modelId?: string | null;
}): ProviderReplayPolicy | undefined {
  const isGoogle = isGoogleModelApi(params.modelApi);
  const isAnthropic = isAnthropicApi(params.modelApi);
  const isStrictOpenAiCompatible = params.modelApi === "openai-completions";
  const requiresOpenAiCompatibleToolIdSanitization =
    params.modelApi === "openai-completions" ||
    params.modelApi === "openai-responses" ||
    params.modelApi === "openai-codex-responses" ||
    params.modelApi === "azure-openai-responses";

  if (
    !isGoogle &&
    !isAnthropic &&
    !isStrictOpenAiCompatible &&
    !requiresOpenAiCompatibleToolIdSanitization
  ) {
    return undefined;
  }

  const modelId = normalizeLowercaseStringOrEmpty(params.modelId);
  return {
    ...(isGoogle || isAnthropic ? { sanitizeMode: "full" as const } : {}),
    ...(isGoogle || isAnthropic || requiresOpenAiCompatibleToolIdSanitization
      ? {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict" as const,
        }
      : {}),
    ...(isAnthropic ? { preserveSignatures: true } : {}),
    ...(isGoogle
      ? {
          sanitizeThoughtSignatures: {
            allowBase64Only: true,
            includeCamelCase: true,
          },
        }
      : {}),
    ...(isAnthropic && modelId.includes("claude")
      ? { dropThinkingBlocks: !shouldPreserveThinkingBlocks(modelId) }
      : {}),
    ...(isGoogle || isStrictOpenAiCompatible ? { applyAssistantFirstOrderingFix: true } : {}),
    ...(isGoogle || isStrictOpenAiCompatible ? { validateGeminiTurns: true } : {}),
    ...(isAnthropic || isStrictOpenAiCompatible ? { validateAnthropicTurns: true } : {}),
    ...(isGoogle || isAnthropic ? { allowSyntheticToolResults: true } : {}),
  };
}

function mergeTranscriptPolicy(
  policy: ProviderReplayPolicy | undefined,
  basePolicy: TranscriptPolicy = DEFAULT_TRANSCRIPT_POLICY,
): TranscriptPolicy {
  if (!policy) {
    return basePolicy;
  }

  return {
    ...basePolicy,
    ...(policy.sanitizeMode != null ? { sanitizeMode: policy.sanitizeMode } : {}),
    ...(typeof policy.sanitizeToolCallIds === "boolean"
      ? { sanitizeToolCallIds: policy.sanitizeToolCallIds }
      : {}),
    ...(policy.toolCallIdMode ? { toolCallIdMode: policy.toolCallIdMode as ToolCallIdMode } : {}),
    ...(typeof policy.preserveNativeAnthropicToolUseIds === "boolean"
      ? { preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds }
      : {}),
    ...(typeof policy.repairToolUseResultPairing === "boolean"
      ? { repairToolUseResultPairing: policy.repairToolUseResultPairing }
      : {}),
    ...(typeof policy.preserveSignatures === "boolean"
      ? { preserveSignatures: policy.preserveSignatures }
      : {}),
    ...(policy.sanitizeThoughtSignatures
      ? { sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures }
      : {}),
    ...(typeof policy.dropThinkingBlocks === "boolean"
      ? { dropThinkingBlocks: policy.dropThinkingBlocks }
      : {}),
    ...(typeof policy.applyAssistantFirstOrderingFix === "boolean"
      ? { applyGoogleTurnOrdering: policy.applyAssistantFirstOrderingFix }
      : {}),
    ...(typeof policy.validateGeminiTurns === "boolean"
      ? { validateGeminiTurns: policy.validateGeminiTurns }
      : {}),
    ...(typeof policy.validateAnthropicTurns === "boolean"
      ? { validateAnthropicTurns: policy.validateAnthropicTurns }
      : {}),
    ...(typeof policy.allowSyntheticToolResults === "boolean"
      ? { allowSyntheticToolResults: policy.allowSyntheticToolResults }
      : {}),
  };
}

export function resolveTranscriptPolicy(params: {
  modelApi?: string | null;
  provider?: string | null;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  model?: ProviderRuntimeModel;
}): TranscriptPolicy {
  const provider = normalizeProviderId(params.provider ?? "");
  const runtimePlugin = provider
    ? resolveProviderRuntimePlugin({
        provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      })
    : undefined;
  const context = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider,
    modelId: params.modelId ?? "",
    modelApi: params.modelApi,
    model: params.model,
  };

  // Once a provider adopts the replay-policy hook, replay policy should come
  // from the plugin, not from transport-family defaults in core.
  const buildReplayPolicy = runtimePlugin?.buildReplayPolicy;
  if (buildReplayPolicy) {
    const pluginPolicy = buildReplayPolicy(context);
    return mergeTranscriptPolicy(pluginPolicy ?? undefined);
  }

  return mergeTranscriptPolicy(
    buildUnownedProviderTransportReplayFallback({
      modelApi: params.modelApi,
      modelId: params.modelId,
    }),
  );
}
