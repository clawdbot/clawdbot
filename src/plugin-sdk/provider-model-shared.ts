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
  ProviderRuntimeModel,
  ProviderSanitizeReplayHistoryContext,
} from "./plugin-entry.js";

export type {
  ModelApi,
  ModelProviderDeclarationConfig as ModelProviderConfig,
} from "../config/types.models.js";
export {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeNativeThinkingLevelMap,
  resolveClaudeSonnet5ModelIdentity,
  requiresClaudeDefaultSampling,
  requiresClaudeMandatoryAdaptiveThinking,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "@openclaw/llm-core";
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

/** Compare canonical flat rates without assuming display-only models include cost metadata. */
export function modelCostsEqual(
  current: ProviderRuntimeModel["cost"] | undefined,
  expected: ProviderRuntimeModel["cost"],
): boolean {
  return (
    current?.input === expected.input &&
    current?.output === expected.output &&
    current?.cacheRead === expected.cacheRead &&
    current?.cacheWrite === expected.cacheWrite
  );
}

const LOCAL_MODEL_FAMILY_PREFERENCES = [
  // Gemma 4 leads: live bench of the system-agent contract (planner JSON +
  // openclaw tool calls) scored gemma4:e4b well above qwen3.5:4b on approval
  // follow-through and structured-command accuracy at ~2.5x lower latency.
  /gemma[-_.]?4(?!\d)/,
  /qwen[-_.]?3[._]5(?!\d)/,
  /qwen[-_.]?3(?!\d)/,
  /gpt[-_.]?oss/,
  /gemma[-_.]?3(?!\d)/,
  /llama[-_.]?4(?!\d)/,
  /llama[-_.]?3(?!\d)/,
  /phi[-_.]?4(?!\d)/,
  /mistral/,
  /deepseek/,
] as const;
const LOCAL_MODEL_SPECIALIST_PATTERN = /embed|rerank|whisper|-vl\b|vision|omni|guard/;

/**
 * Setup-assistant preference for agentic tool-calling quality in current BFCL-class results.
 * Heuristic contract; safe to retune as local model families improve.
 */
export function selectPreferredLocalModelId(modelIds: readonly string[]): string | undefined {
  const familyCount = LOCAL_MODEL_FAMILY_PREFERENCES.length;
  let preferred: string | undefined;
  let preferredRank = Number.POSITIVE_INFINITY;

  for (const rawId of modelIds) {
    const id = rawId.trim();
    if (!id) {
      continue;
    }
    const normalized = id.toLowerCase();
    const familyRank = LOCAL_MODEL_FAMILY_PREFERENCES.findIndex((pattern) =>
      pattern.test(normalized),
    );
    // Rank buckets, best to worst: known family (0..N-1), known-family coder
    // (N..2N-1), unknown chat (2N), unknown coder (2N+1), specialist (3N).
    // Strict `<` below keeps the caller's original order within a bucket.
    const rank = LOCAL_MODEL_SPECIALIST_PATTERN.test(normalized)
      ? familyCount * 3
      : familyRank >= 0
        ? familyRank + (normalized.includes("coder") ? familyCount : 0)
        : familyCount * 2 + (normalized.includes("coder") ? 1 : 0);
    if (rank < preferredRank) {
      preferred = id;
      preferredRank = rank;
    }
  }

  return preferred;
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

export {
  isClaudeAdaptiveThinkingDefaultModelId,
  resolveClaudeThinkingProfile,
} from "../plugins/provider-claude-thinking.js";

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
      /** Optional output style for repeated tool call ids. */
      duplicateToolCallIdStyle?: "openai";
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
        duplicateToolCallIdStyle: options.duplicateToolCallIdStyle,
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
