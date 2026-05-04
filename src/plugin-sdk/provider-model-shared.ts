// Shared model/catalog helpers for provider plugins.
//
// Keep provider-owned exports out of this subpath so plugin loaders can import it
// without recursing through provider-specific facades.

import type { BedrockDiscoveryConfig, ModelDefinitionConfig } from "../config/types.models.js";
import {
  buildAnthropicReplayPolicyForModel,
  buildGoogleGeminiReplayPolicy,
  buildHybridAnthropicOrOpenAIReplayPolicy,
  buildNativeAnthropicReplayPolicyForModel,
  buildOpenAICompatibleReplayPolicy,
  buildPassthroughGeminiSanitizingReplayPolicy,
  buildStrictAnthropicReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
} from "../plugins/provider-replay-helpers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type {
  ProviderReasoningOutputModeContext,
  ProviderReplayPolicyContext,
  ProviderSanitizeReplayHistoryContext,
  ProviderThinkingProfile,
} from "./plugin-entry.js";
import {
  normalizeAntigravityPreviewModelId,
  normalizeGooglePreviewModelId,
  normalizeNativeXaiModelId,
} from "./provider-model-id-normalize.js";

export type { ModelApi, ModelProviderConfig } from "../config/types.models.js";
export type {
  BedrockDiscoveryConfig,
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "../config/types.models.js";
export type {
  ProviderEndpointClass,
  ProviderEndpointResolution,
} from "../agents/provider-attribution.js";
export type { ProviderPlugin } from "../plugins/types.js";

export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
export {
  GPT5_BEHAVIOR_CONTRACT,
  GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY,
  GPT5_FRIENDLY_PROMPT_OVERLAY,
  GPT5_HEARTBEAT_PROMPT_OVERLAY,
  isGpt5ModelId,
  normalizeGpt5PromptOverlayMode,
  renderGpt5PromptOverlay,
  resolveGpt5PromptOverlayMode,
  resolveGpt5SystemPromptContribution,
  type Gpt5PromptOverlayMode,
} from "../agents/gpt5-prompt-overlay.js";
export { resolveProviderEndpoint } from "../agents/provider-attribution.js";
export {
  applyModelCompatPatch,
  hasToolSchemaProfile,
  hasNativeWebSearchTool,
  normalizeModelCompat,
  resolveUnsupportedToolSchemaKeywords,
  resolveToolCallArgumentsEncoding,
} from "../plugins/provider-model-compat.js";
export { normalizeProviderId } from "../agents/provider-id.js";
export {
  buildAnthropicReplayPolicyForModel,
  buildGoogleGeminiReplayPolicy,
  buildHybridAnthropicOrOpenAIReplayPolicy,
  buildNativeAnthropicReplayPolicyForModel,
  buildOpenAICompatibleReplayPolicy,
  buildPassthroughGeminiSanitizingReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
  buildStrictAnthropicReplayPolicy,
};
export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
export {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
} from "../plugins/provider-model-helpers.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

const CLAUDE_OPUS_47_MODEL_PREFIXES = ["claude-opus-4-7", "claude-opus-4.7"] as const;
const CLAUDE_ADAPTIVE_THINKING_DEFAULT_MODEL_PREFIXES = [
  "claude-opus-4-6",
  "claude-opus-4.6",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
] as const;
const BASE_CLAUDE_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

export function getModelProviderHint(modelId: string): string | null {
  const trimmed = normalizeOptionalLowercaseString(modelId);
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }
  return trimmed.slice(0, slashIndex) || null;
}

export function isProxyReasoningUnsupportedModelHint(modelId: string): boolean {
  return getModelProviderHint(modelId) === "x-ai";
}

function matchesClaudeModelPrefix(modelId: string, prefixes: readonly string[]): boolean {
  const lower = normalizeOptionalLowercaseString(modelId);
  return Boolean(lower && prefixes.some((prefix) => lower.startsWith(prefix)));
}

export function isClaudeOpus47ModelId(modelId: string): boolean {
  return matchesClaudeModelPrefix(modelId, CLAUDE_OPUS_47_MODEL_PREFIXES);
}

export function isClaudeAdaptiveThinkingDefaultModelId(modelId: string): boolean {
  return matchesClaudeModelPrefix(modelId, CLAUDE_ADAPTIVE_THINKING_DEFAULT_MODEL_PREFIXES);
}

export function resolveClaudeThinkingProfile(modelId: string): ProviderThinkingProfile {
  if (isClaudeOpus47ModelId(modelId)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
  if (isClaudeAdaptiveThinkingDefaultModelId(modelId)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "adaptive" }],
      defaultLevel: "adaptive",
    };
  }
  return { levels: BASE_CLAUDE_THINKING_LEVELS };
}

export {
  normalizeAntigravityPreviewModelId,
  normalizeGooglePreviewModelId,
  normalizeNativeXaiModelId,
};

export type ProviderReplayFamily =
  | "openai-compatible"
  | "anthropic-by-model"
  | "native-anthropic-by-model"
  | "google-gemini"
  | "passthrough-gemini"
  | "hybrid-anthropic-openai";

type ProviderReplayFamilyHooks = Pick<
  ProviderPlugin,
  "buildReplayPolicy" | "sanitizeReplayHistory" | "resolveReasoningOutputMode"
>;

type BuildProviderReplayFamilyHooksOptions =
  | { family: "openai-compatible"; sanitizeToolCallIds?: boolean }
  | { family: "anthropic-by-model" }
  | { family: "native-anthropic-by-model" }
  | { family: "google-gemini" }
  | { family: "passthrough-gemini" }
  | {
      family: "hybrid-anthropic-openai";
      anthropicModelDropThinkingBlocks?: boolean;
    };

export function buildProviderReplayFamilyHooks(
  options: BuildProviderReplayFamilyHooksOptions,
): ProviderReplayFamilyHooks {
  switch (options.family) {
    case "openai-compatible": {
      const policyOptions = { sanitizeToolCallIds: options.sanitizeToolCallIds };
      return {
        buildReplayPolicy: (ctx: ProviderReplayPolicyContext) =>
          buildOpenAICompatibleReplayPolicy(ctx.modelApi, {
            ...policyOptions,
            modelId: ctx.modelId,
          }),
      };
    }
    case "anthropic-by-model":
      return {
        buildReplayPolicy: ({ modelId }: ProviderReplayPolicyContext) =>
          buildAnthropicReplayPolicyForModel(modelId),
      };
    case "native-anthropic-by-model":
      return {
        buildReplayPolicy: ({ modelId }: ProviderReplayPolicyContext) =>
          buildNativeAnthropicReplayPolicyForModel(modelId),
      };
    case "google-gemini":
      return {
        buildReplayPolicy: () => buildGoogleGeminiReplayPolicy(),
        sanitizeReplayHistory: (ctx: ProviderSanitizeReplayHistoryContext) =>
          sanitizeGoogleGeminiReplayHistory(ctx),
        resolveReasoningOutputMode: (_ctx: ProviderReasoningOutputModeContext) =>
          resolveTaggedReasoningOutputMode(),
      };
    case "passthrough-gemini":
      return {
        buildReplayPolicy: ({ modelId }: ProviderReplayPolicyContext) =>
          buildPassthroughGeminiSanitizingReplayPolicy(modelId),
      };
    case "hybrid-anthropic-openai":
      return {
        buildReplayPolicy: (ctx: ProviderReplayPolicyContext) =>
          buildHybridAnthropicOrOpenAIReplayPolicy(ctx, {
            anthropicModelDropThinkingBlocks: options.anthropicModelDropThinkingBlocks,
          }),
      };
  }
  throw new Error("Unsupported provider replay family");
}

export const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

export const ANTHROPIC_BY_MODEL_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "anthropic-by-model",
});

export const NATIVE_ANTHROPIC_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "native-anthropic-by-model",
});

export const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});
