// Provider stream helpers expose shared wrapper families and payload transforms for provider plugins.
import { createGoogleThinkingPayloadWrapper } from "../llm/providers/stream-wrappers/google.js";
import { createMinimaxFastModeWrapper } from "../llm/providers/stream-wrappers/minimax.js";
import { resolveMoonshotThinkingKeep } from "../llm/providers/stream-wrappers/moonshot-thinking.js";
import {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAIStringContentWrapper,
  createOpenAITextVerbosityWrapper,
  createOpenAIThinkingLevelWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
  resolveOpenAITextVerbosity,
} from "../llm/providers/stream-wrappers/openai.js";
import {
  createKilocodeWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../llm/providers/stream-wrappers/proxy.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";
import {
  createMoonshotThinkingWrapper,
  createToolStreamWrapper,
  resolveMoonshotThinkingType,
} from "./provider-stream-shared.js";
export {
  applyAnthropicEphemeralCacheControlMarkers,
  applyAnthropicPayloadPolicyToParams,
  composeProviderStreamWrappers,
  createAnthropicThinkingPrefillPayloadWrapper,
  createMoonshotThinkingWrapper,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
  defaultToolStreamExtraParams,
  isOpenAICompatibleThinkingEnabled,
  type ProviderStreamWrapperFactory,
  resolveAnthropicPayloadPolicy,
  resolveMoonshotThinkingType,
  streamWithPayloadPatch,
  stripTrailingAnthropicAssistantPrefillWhenThinking,
} from "./provider-stream-shared.js";

/** Named stream-wrapper bundles that provider plugins can opt into without duplicating policy. */
export type ProviderStreamFamily =
  /** Applies Google thinking-level payload normalization. */
  | "google-thinking"
  /** Applies Kilocode proxy reasoning payload normalization. */
  | "kilocode-thinking"
  /** Applies Moonshot thinking type/keep normalization. */
  | "moonshot-thinking"
  /** Enables MiniMax high-speed model routing when requested. */
  | "minimax-fast-mode"
  /** Applies the default OpenAI Responses wrapper stack. */
  | "openai-responses-defaults"
  /** Applies OpenRouter proxy reasoning payload normalization. */
  | "openrouter-thinking"
  /** Enables tool-call event streaming unless explicitly disabled. */
  | "tool-stream-default-on";

type ProviderStreamFamilyHooks = Pick<ProviderPlugin, "wrapStreamFn">;

function hasFastModeParam(extraParams: Record<string, unknown> | undefined): boolean {
  return Boolean(
    extraParams &&
    (Object.hasOwn(extraParams, "fastMode") || Object.hasOwn(extraParams, "fast_mode")),
  );
}

function resolveBooleanFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  if (typeof raw === "function") {
    const resolved = (raw as () => unknown)();
    return typeof resolved === "boolean" ? resolved : undefined;
  }
  return typeof raw === "boolean" ? raw : undefined;
}

/** Builds provider hook objects for one supported stream-wrapper family. */
export function buildProviderStreamFamilyHooks(
  /**
   * Family key selecting the exact wrapper bundle to attach to a provider.
   */
  family: ProviderStreamFamily,
): ProviderStreamFamilyHooks {
  switch (family) {
    case "google-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel),
      };
    case "moonshot-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          const thinkingType = resolveMoonshotThinkingType({
            configuredThinking: ctx.extraParams?.thinking,
            thinkingLevel: ctx.thinkingLevel,
          });
          const thinkingKeep = resolveMoonshotThinkingKeep({
            configuredThinking: ctx.extraParams?.thinking,
          });
          return createMoonshotThinkingWrapper(ctx.streamFn, thinkingType, thinkingKeep);
        },
      };
    case "kilocode-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          const thinkingLevel =
            ctx.modelId === "kilo-auto/balanced" || isProxyReasoningUnsupported(ctx.modelId)
              ? undefined
              : ctx.thinkingLevel;
          return createKilocodeWrapper(ctx.streamFn, thinkingLevel);
        },
      };
    case "minimax-fast-mode":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createMinimaxFastModeWrapper(ctx.streamFn, () => resolveBooleanFastMode(ctx.extraParams)),
      };
    case "openai-responses-defaults":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          // Wrapper order is observable: header/default params must be in place
          // before payload-shape and context-management compatibility rewrites.
          let nextStreamFn = createOpenAIAttributionHeadersWrapper(ctx.streamFn);

          if (hasFastModeParam(ctx.extraParams)) {
            nextStreamFn = createOpenAIFastModeWrapper(nextStreamFn, () =>
              resolveOpenAIFastMode(ctx.extraParams),
            );
          }

          const serviceTier = resolveOpenAIServiceTier(ctx.extraParams);
          if (serviceTier) {
            nextStreamFn = createOpenAIServiceTierWrapper(nextStreamFn, serviceTier);
          }

          const textVerbosity = resolveOpenAITextVerbosity(ctx.extraParams);
          if (textVerbosity) {
            nextStreamFn = createOpenAITextVerbosityWrapper(nextStreamFn, textVerbosity);
          }

          nextStreamFn = createCodexNativeWebSearchWrapper(nextStreamFn, {
            config: ctx.config,
            agentDir: ctx.agentDir,
            agentId: ctx.agentId,
            nativeWebSearchAllowedByToolPolicy: ctx.nativeWebSearchAllowedByToolPolicy,
          });
          nextStreamFn = createOpenAIStringContentWrapper(nextStreamFn);
          return createOpenAIResponsesContextManagementWrapper(
            createOpenAIReasoningCompatibilityWrapper(
              createOpenAIThinkingLevelWrapper(nextStreamFn, ctx.thinkingLevel),
            ),
            ctx.extraParams,
          );
        },
      };
    case "openrouter-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          const thinkingLevel =
            ctx.modelId === "auto" || isProxyReasoningUnsupported(ctx.modelId)
              ? undefined
              : ctx.thinkingLevel;
          return createOpenRouterWrapper(ctx.streamFn, thinkingLevel, ctx.extraParams);
        },
      };
    case "tool-stream-default-on":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createToolStreamWrapper(ctx.streamFn, ctx.extraParams?.tool_stream !== false),
      };
  }
  throw new Error("Unsupported provider stream family");
}

/** @deprecated Google provider-owned stream hook shortcut; use local provider hooks instead. */
export const GOOGLE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("google-thinking");
/** @deprecated Kilocode provider-owned stream hook shortcut; use local provider hooks instead. */
export const KILOCODE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("kilocode-thinking");
/** @deprecated Moonshot provider-owned stream hook shortcut; use local provider hooks instead. */
export const MOONSHOT_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("moonshot-thinking");
/** @deprecated MiniMax provider-owned stream hook shortcut; use local provider hooks instead. */
export const MINIMAX_FAST_MODE_STREAM_HOOKS = buildProviderStreamFamilyHooks("minimax-fast-mode");
/** @deprecated OpenAI provider-owned stream hook shortcut; use local provider hooks instead. */
export const OPENAI_RESPONSES_STREAM_HOOKS = buildProviderStreamFamilyHooks(
  "openai-responses-defaults",
);
/** @deprecated OpenRouter provider-owned stream hook shortcut; use local provider hooks instead. */
export const OPENROUTER_THINKING_STREAM_HOOKS =
  buildProviderStreamFamilyHooks("openrouter-thinking");
/** @deprecated Provider-owned stream hook shortcut; use local provider hooks instead. */
export const TOOL_STREAM_DEFAULT_ON_HOOKS =
  buildProviderStreamFamilyHooks("tool-stream-default-on");

// Public stream-wrapper helpers for provider plugins.

export {
  createAnthropicToolPayloadCompatibilityWrapper,
  createOpenAIAnthropicToolPayloadCompatibilityWrapper,
} from "../llm/providers/stream-wrappers/anthropic-family-tool-payload-compat.js";
export {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
} from "../llm/providers/stream-wrappers/google.js";
export {
  createKilocodeWrapper,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../llm/providers/stream-wrappers/proxy.js";
export { createMinimaxFastModeWrapper } from "../llm/providers/stream-wrappers/minimax.js";
export {
  createOpenAIAttributionHeadersWrapper,
  createCodexNativeWebSearchWrapper,
  createOpenAIDefaultTransportWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAITextVerbosityWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
  resolveOpenAITextVerbosity,
} from "../llm/providers/stream-wrappers/openai.js";
export {
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "../agents/embedded-agent-runner/openrouter-model-capabilities.js";
