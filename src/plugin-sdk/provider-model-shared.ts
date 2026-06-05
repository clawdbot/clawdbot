// Provider model helpers normalize model catalog entries shared by provider plugins.
import { normalizeProviderId as normalizeProviderIdCore } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeAntigravityPreviewModelId as normalizeAntigravityPreviewModelIdCore,
  normalizeGooglePreviewModelId as normalizeGooglePreviewModelIdCore,
} from "@openclaw/model-catalog-core/provider-model-id-normalize";
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

export type {
  ModelApi,
  ModelProviderDeclarationConfig as ModelProviderConfig,
} from "../config/types.models.js";
export type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogKind,
  UnifiedModelCatalogSource,
} from "@openclaw/model-catalog-core/model-catalog-types";
export type {
  BedrockDiscoveryConfig,
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "../config/types.models.js";
export type {
  ProviderEndpointClass,
  ProviderEndpointResolution,
} from "../agents/provider-attribution.js";
export type {
  ProviderPlugin,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
} from "../plugins/types.js";

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

/**
 * Normalizes provider ids for config, catalog, and plugin-registry matching.
 */
export function normalizeProviderId(
  /** Provider id from config, catalog, or plugin metadata. */
  provider: string,
): string {
  return normalizeProviderIdCore(provider);
}
export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../llm/providers/stream-wrappers/moonshot-thinking.js";
export {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
} from "../plugins/provider-model-helpers.js";
import { normalizeOptionalLowercaseString } from "../../packages/normalization-core/src/string-coerce.js";

const CLAUDE_OPUS_48_MODEL_PREFIXES = ["claude-opus-4-8", "claude-opus-4.8"] as const;
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

function getModelProviderHint(modelId: string): string | null {
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

/** @deprecated Proxy provider-owned model helper; do not use from third-party plugins. */
export function isProxyReasoningUnsupportedModelHint(
  /** Model id that may include a provider prefix such as `x-ai/model`. */
  modelId: string,
): boolean {
  return getModelProviderHint(modelId) === "x-ai";
}

function matchesClaudeModelPrefix(modelId: string, prefixes: readonly string[]): boolean {
  const lower = normalizeOptionalLowercaseString(modelId);
  return Boolean(lower && prefixes.some((prefix) => lower.startsWith(prefix)));
}

function isClaudeOpus47ModelId(modelId: string): boolean {
  return matchesClaudeModelPrefix(modelId, CLAUDE_OPUS_47_MODEL_PREFIXES);
}

function isClaudeOpus48ModelId(modelId: string): boolean {
  return matchesClaudeModelPrefix(modelId, CLAUDE_OPUS_48_MODEL_PREFIXES);
}

/** @deprecated Anthropic provider-owned model helper; do not use from third-party plugins. */
export function isClaudeAdaptiveThinkingDefaultModelId(
  /** Claude model id to check against adaptive-thinking default families. */
  modelId: string,
): boolean {
  return matchesClaudeModelPrefix(modelId, CLAUDE_ADAPTIVE_THINKING_DEFAULT_MODEL_PREFIXES);
}

/** @deprecated Anthropic provider-owned model helper; do not use from third-party plugins. */
export function resolveClaudeThinkingProfile(
  /** Claude model id used to choose available thinking levels and defaults. */
  modelId: string,
): ProviderThinkingProfile {
  if (isClaudeOpus48ModelId(modelId)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
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

/**
 * Normalizes Antigravity preview model ids to the canonical provider catalog form.
 */
export function normalizeAntigravityPreviewModelId(
  /** Antigravity preview model id from config or catalog data. */
  id: string,
): string {
  return normalizeAntigravityPreviewModelIdCore(id);
}

/**
 * Normalizes Google preview model ids to the canonical provider catalog form.
 */
export function normalizeGooglePreviewModelId(
  /** Google preview model id from config or catalog data. */
  id: string,
): string {
  return normalizeGooglePreviewModelIdCore(id);
}

/**
 * Shared replay-policy families reused by provider plugins with matching transcript semantics.
 */
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
  | {
      /** OpenAI-compatible transcript family using OpenAI-style tool calls. */
      family: "openai-compatible";
      /** Whether replay policy should rewrite tool call ids for provider compatibility. */
      sanitizeToolCallIds?: boolean;
      /** Whether replay policy should strip reasoning blocks from history. */
      dropReasoningFromHistory?: boolean;
    }
  | {
      /** Anthropic-style transcript policy selected by Claude model id. */
      family: "anthropic-by-model";
    }
  | {
      /** Native Anthropic transcript policy preserving Anthropic ids/signatures. */
      family: "native-anthropic-by-model";
    }
  | {
      /** Google Gemini transcript policy with Gemini replay sanitation hooks. */
      family: "google-gemini";
    }
  | {
      /** OpenAI-compatible transport carrying Gemini-style thought signatures. */
      family: "passthrough-gemini";
    }
  | {
      /** Family that switches between Anthropic and OpenAI-compatible replay by request context. */
      family: "hybrid-anthropic-openai";
      /** Whether Anthropic-model replay should drop thinking blocks in hybrid mode. */
      anthropicModelDropThinkingBlocks?: boolean;
    };

/**
 * Builds provider replay hooks for a known transcript/reasoning compatibility family.
 */
export function buildProviderReplayFamilyHooks(
  options: BuildProviderReplayFamilyHooksOptions,
): ProviderReplayFamilyHooks {
  switch (options.family) {
    case "openai-compatible": {
      const policyOptions = {
        sanitizeToolCallIds: options.sanitizeToolCallIds,
        dropReasoningFromHistory: options.dropReasoningFromHistory,
      };
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

/** @deprecated Provider-owned replay hook shortcut; use local provider hooks instead. */
export const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

/** @deprecated Anthropic provider-owned replay hook shortcut; use local provider hooks instead. */
export const ANTHROPIC_BY_MODEL_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "anthropic-by-model",
});

/** @deprecated Anthropic provider-owned replay hook shortcut; use local provider hooks instead. */
export const NATIVE_ANTHROPIC_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "native-anthropic-by-model",
});

/** @deprecated Google provider-owned replay hook shortcut; use local provider hooks instead. */
export const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});
