/**
 * OpenAI-completions compatibility defaults.
 *
 * Provider transports use these helpers to derive OpenAI-compatible request
 * behavior from endpoint attribution without scattering provider-specific flags.
 */
import type { Model, OpenAICompletionsCompat } from "@openclaw/llm-core";
import type { AiProviderRequestCapabilities, AiProviderRequestPolicyInput } from "../host.js";
import { isKnownOpenAIJsonSchemaModelId } from "../providers/openai-response-format.js";
import { resolveProviderRequestCapabilities as resolveModelProviderRequestCapabilities } from "./host-policy.js";

type ProviderEndpointClass = string;
type ProviderRequestCapabilities = AiProviderRequestCapabilities;
type OpenAICompletionsSessionAffinity = "none" | "openai" | "openrouter";

type OpenAICompletionsCompatDefaultsInput = {
  provider?: string;
  modelId?: string;
  baseUrl?: string;
  endpointClass: ProviderEndpointClass;
  knownProviderFamily: string;
  supportsNativeStreamingUsageCompat?: boolean;
  supportsOpenAICompletionsStreamingUsageCompat?: boolean;
  usesExplicitProxyLikeEndpoint?: boolean;
};

type OpenAICompletionsCompatDefaults = {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  supportsUsageInStreaming: boolean;
  maxTokensField: "max_completion_tokens" | "max_tokens";
  thinkingFormat: "openai" | "openrouter" | "deepseek" | "together" | "zai";
  visibleReasoningDetailTypes: string[];
  supportsStrictMode: boolean;
  supportsJsonSchemaResponseFormat: boolean;
  requiresReasoningContentOnAssistantMessages: boolean;
  requiresNonEmptyUserOrAssistantMessage: boolean;
  cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
  sessionAffinityFormat: Exclude<OpenAICompletionsSessionAffinity, "none">;
  supportsLongCacheRetention: boolean;
};

type DetectedOpenAICompletionsCompat = {
  capabilities: ProviderRequestCapabilities;
  defaults: OpenAICompletionsCompatDefaults;
};

export type ResolvedOpenAICompletionsCompat = Omit<
  Required<OpenAICompletionsCompat>,
  "cacheControlFormat" | "openRouterRouting" | "sendSessionAffinityHeaders" | "reasoningEffortMap"
> & {
  cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
  openRouterRouting?: OpenAICompletionsCompat["openRouterRouting"];
  sessionAffinity: OpenAICompletionsSessionAffinity;
  visibleReasoningDetailTypes: string[];
  requiresNonEmptyUserOrAssistantMessage: boolean;
};

function isDefaultRouteProvider(provider: string | undefined, ...ids: string[]) {
  return provider !== undefined && ids.includes(provider);
}

/** Resolves default request flags for an OpenAI-compatible completions endpoint. */
function resolveOpenAICompletionsCompatDefaults(
  input: OpenAICompletionsCompatDefaultsInput,
): OpenAICompletionsCompatDefaults {
  const {
    provider,
    modelId,
    endpointClass,
    knownProviderFamily,
    supportsNativeStreamingUsageCompat = false,
    supportsOpenAICompletionsStreamingUsageCompat = false,
    usesExplicitProxyLikeEndpoint = false,
  } = input;
  const isDefaultRoute = endpointClass === "default";
  const usesConfiguredNonOpenAIEndpoint =
    endpointClass !== "default" && endpointClass !== "openai-public";
  const isMoonshot = knownProviderFamily === "moonshot" || endpointClass === "moonshot-native";
  const isMoonshotLike =
    isMoonshot || knownProviderFamily === "modelstudio" || endpointClass === "modelstudio-native";
  const isModelStudioLike =
    knownProviderFamily === "modelstudio" ||
    endpointClass === "modelstudio-native" ||
    (isDefaultRoute && isDefaultRouteProvider(provider, "dashscope", "modelstudio", "qwen"));
  const isZai =
    endpointClass === "zai-native" ||
    (isDefaultRoute && isDefaultRouteProvider(input.provider, "zai"));
  const isDeepSeek =
    endpointClass === "deepseek-native" ||
    (isDefaultRoute && isDefaultRouteProvider(input.provider, "deepseek"));
  const isTogether =
    knownProviderFamily === "together" ||
    input.baseUrl?.includes("api.together.ai") === true ||
    input.baseUrl?.includes("api.together.xyz") === true ||
    (isDefaultRoute && isDefaultRouteProvider(input.provider, "together"));
  const isCloudflareAiGateway =
    provider === "cloudflare-ai-gateway" ||
    input.baseUrl?.includes("gateway.ai.cloudflare.com") === true;
  const isXiaomi =
    endpointClass === "xiaomi-native" ||
    (isDefaultRoute && isDefaultRouteProvider(input.provider, "xiaomi"));
  const isNonStandard =
    endpointClass === "cerebras-native" ||
    endpointClass === "chutes-native" ||
    endpointClass === "deepseek-native" ||
    endpointClass === "mistral-public" ||
    endpointClass === "opencode-native" ||
    endpointClass === "xai-native" ||
    isXiaomi ||
    isZai ||
    (isDefaultRoute &&
      isDefaultRouteProvider(input.provider, "cerebras", "chutes", "deepseek", "opencode", "xai"));
  const isOpenRouterLike = input.provider === "openrouter" || endpointClass === "openrouter";
  const isLocalEndpoint = endpointClass === "local";
  const usesMaxTokens =
    endpointClass === "chutes-native" ||
    endpointClass === "mistral-public" ||
    knownProviderFamily === "mistral" ||
    isMoonshot ||
    isCloudflareAiGateway ||
    isZai ||
    isTogether ||
    (isDefaultRoute && isDefaultRouteProvider(provider, "chutes"));
  return {
    supportsStore:
      !isNonStandard && knownProviderFamily !== "mistral" && !usesExplicitProxyLikeEndpoint,
    supportsDeveloperRole: !isNonStandard && !isMoonshotLike && !usesConfiguredNonOpenAIEndpoint,
    supportsReasoningEffort:
      !isZai &&
      !isTogether &&
      knownProviderFamily !== "mistral" &&
      endpointClass !== "xai-native" &&
      !usesExplicitProxyLikeEndpoint,
    supportsUsageInStreaming:
      supportsOpenAICompletionsStreamingUsageCompat ||
      (!isNonStandard &&
        (isLocalEndpoint ||
          !usesConfiguredNonOpenAIEndpoint ||
          supportsNativeStreamingUsageCompat)),
    maxTokensField: usesMaxTokens ? "max_tokens" : "max_completion_tokens",
    thinkingFormat:
      isDeepSeek || isXiaomi
        ? "deepseek"
        : isZai
          ? "zai"
          : isTogether
            ? "together"
            : isOpenRouterLike
              ? "openrouter"
              : "openai",
    visibleReasoningDetailTypes: isOpenRouterLike ? ["response.output_text", "response.text"] : [],
    supportsStrictMode: !isZai && !usesConfiguredNonOpenAIEndpoint,
    supportsJsonSchemaResponseFormat:
      (endpointClass === "openai-public" ||
        (isDefaultRoute && isDefaultRouteProvider(provider, "openai"))) &&
      isKnownOpenAIJsonSchemaModelId(modelId),
    requiresReasoningContentOnAssistantMessages: isDeepSeek || isXiaomi,
    requiresNonEmptyUserOrAssistantMessage: isModelStudioLike,
    cacheControlFormat:
      (isModelStudioLike && endpointClass !== "custom") ||
      (provider === "openrouter" && modelId?.startsWith("anthropic/") === true)
        ? "anthropic"
        : undefined,
    sessionAffinityFormat: isOpenRouterLike ? "openrouter" : "openai",
    supportsLongCacheRetention:
      !isModelStudioLike &&
      provider !== "cloudflare-workers-ai" &&
      provider !== "cloudflare-ai-gateway" &&
      knownProviderFamily !== "together" &&
      !input.baseUrl?.includes("api.cloudflare.com") &&
      !input.baseUrl?.includes("gateway.ai.cloudflare.com") &&
      !input.baseUrl?.includes("api.together.ai") &&
      !input.baseUrl?.includes("api.together.xyz"),
  };
}

function resolveOpenAICompletionsCompatDefaultsFromCapabilities(
  input: Pick<
    ProviderRequestCapabilities,
    | "endpointClass"
    | "knownProviderFamily"
    | "supportsNativeStreamingUsageCompat"
    | "supportsOpenAICompletionsStreamingUsageCompat"
    | "usesExplicitProxyLikeEndpoint"
  > & {
    provider?: string;
    modelId?: string;
    baseUrl?: string;
  },
): OpenAICompletionsCompatDefaults {
  return resolveOpenAICompletionsCompatDefaults(input);
}

/** Detects endpoint capabilities and defaults for an OpenAI-completions model. */
export function detectOpenAICompletionsCompat(
  model: Pick<Model<"openai-completions">, "provider" | "baseUrl" | "id"> & {
    compat?: { supportsStore?: boolean } | null;
  },
  resolveCapabilities?: (input: AiProviderRequestPolicyInput) => ProviderRequestCapabilities,
): DetectedOpenAICompletionsCompat {
  const capabilities = (
    resolveCapabilities ?? ((input) => resolveModelProviderRequestCapabilities(input, model))
  )({
    provider: model.provider,
    api: "openai-completions",
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    modelId: model.id,
    compat:
      model.compat && typeof model.compat === "object"
        ? (model.compat as { supportsStore?: boolean })
        : undefined,
  });
  return {
    capabilities,
    defaults: resolveOpenAICompletionsCompatDefaultsFromCapabilities({
      provider: model.provider,
      modelId: model.id,
      baseUrl: model.baseUrl,
      ...capabilities,
    }),
  };
}

function resolveSessionAffinity(
  model: Pick<Model<"openai-completions">, "compat">,
  detectedFormat: OpenAICompletionsCompatDefaults["sessionAffinityFormat"],
): OpenAICompletionsSessionAffinity {
  if (model.compat?.sendSessionAffinityHeaders !== true) {
    return "none";
  }
  if (
    detectedFormat === "openrouter" ||
    model.compat.thinkingFormat === "openrouter" ||
    model.compat.openRouterRouting !== undefined
  ) {
    return "openrouter";
  }
  return "openai";
}

/** Applies explicit model overrides once on top of the canonical transport defaults. */
export function resolveOpenAICompletionsCompat(
  model: Pick<Model<"openai-completions">, "id" | "provider" | "baseUrl" | "compat">,
  resolveCapabilities?: (input: AiProviderRequestPolicyInput) => ProviderRequestCapabilities,
): ResolvedOpenAICompletionsCompat {
  const { defaults } = detectOpenAICompletionsCompat(model, resolveCapabilities);
  const configured = model.compat;
  return {
    supportsStore: configured?.supportsStore ?? defaults.supportsStore,
    supportsDeveloperRole: configured?.supportsDeveloperRole ?? defaults.supportsDeveloperRole,
    supportsReasoningEffort:
      configured?.supportsReasoningEffort ?? defaults.supportsReasoningEffort,
    supportsUsageInStreaming:
      configured?.supportsUsageInStreaming ?? defaults.supportsUsageInStreaming,
    maxTokensField: configured?.maxTokensField ?? defaults.maxTokensField,
    requiresToolResultName: configured?.requiresToolResultName ?? false,
    requiresAssistantAfterToolResult: configured?.requiresAssistantAfterToolResult ?? false,
    requiresThinkingAsText: configured?.requiresThinkingAsText ?? false,
    requiresReasoningContentOnAssistantMessages:
      configured?.requiresReasoningContentOnAssistantMessages ??
      defaults.requiresReasoningContentOnAssistantMessages,
    thinkingFormat: configured?.thinkingFormat ?? defaults.thinkingFormat,
    openRouterRouting: configured?.openRouterRouting,
    vercelGatewayRouting: configured?.vercelGatewayRouting ?? {},
    zaiToolStream: configured?.zaiToolStream ?? false,
    supportsStrictMode: configured?.supportsStrictMode ?? defaults.supportsStrictMode,
    supportsJsonSchemaResponseFormat:
      configured?.supportsJsonSchemaResponseFormat ?? defaults.supportsJsonSchemaResponseFormat,
    cacheControlFormat: configured?.cacheControlFormat ?? defaults.cacheControlFormat,
    sessionAffinity: resolveSessionAffinity(model, defaults.sessionAffinityFormat),
    supportsPromptCacheKey: configured?.supportsPromptCacheKey ?? false,
    supportsLongCacheRetention:
      configured?.supportsLongCacheRetention ?? defaults.supportsLongCacheRetention,
    visibleReasoningDetailTypes:
      configured && "visibleReasoningDetailTypes" in configured
        ? ((configured as { visibleReasoningDetailTypes?: string[] }).visibleReasoningDetailTypes ??
          defaults.visibleReasoningDetailTypes)
        : defaults.visibleReasoningDetailTypes,
    requiresNonEmptyUserOrAssistantMessage: defaults.requiresNonEmptyUserOrAssistantMessage,
  };
}
