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
import {
  isAzureFoundryMultiModelHostname,
  isDedicatedAzureOpenAIHostname,
} from "./azure-openai-hostnames-internal.js";

type ProviderEndpointClass = string;
type ProviderRequestCapabilities = AiProviderRequestCapabilities;
type OpenAICompletionsSessionAffinity = "none" | "openai" | "openrouter";

type OpenAICompletionsCompatDefaultsInput = {
  provider?: string;
  modelId?: string;
  modelName?: string;
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
  supportsPromptCacheKey: boolean;
  supportsLongCacheRetention: boolean;
};

type DetectedOpenAICompletionsCompat = {
  capabilities: ProviderRequestCapabilities;
  defaults: OpenAICompletionsCompatDefaults;
};

export type ResolvedOpenAICompletionsCompat = Omit<
  Required<OpenAICompletionsCompat>,
  "cacheControlFormat" | "openRouterRouting" | "sendSessionAffinityHeaders"
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

/**
 * Azure AI Foundry resources front arbitrary model vendors, so on those hosts
 * the prompt-cache-key default only applies to deployments that look like
 * first-party OpenAI models. Foundry deployment ids are operator-chosen (for
 * example `prod-spud`), so the display-name metadata counts as well. `gpt-oss`
 * is the open-weight family served via serverless inference, not an Azure
 * OpenAI deployment, so it stays excluded on both fields.
 */
function isOpenAIFamilyFoundryDeployment(
  modelId: string | undefined,
  modelName: string | undefined,
): boolean {
  const idTail = modelId === undefined ? undefined : modelId.slice(modelId.lastIndexOf("/") + 1);
  return matchesOpenAIFamilyModelToken(idTail) || matchesOpenAIFamilyModelToken(modelName);
}

/**
 * Matches deployment ids and display names alike, so separators cover both id
 * style (`o3-mini`) and name style (`GPT-5.5 (Azure)`, `Codex Mini`).
 */
function matchesOpenAIFamilyModelToken(token: string | undefined): boolean {
  const normalized = token?.trim().toLowerCase();
  if (!normalized || normalized.startsWith("gpt-oss")) {
    return false;
  }
  return (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("chatgpt-") ||
    /^codex(?:[-\s(]|$)/.test(normalized) ||
    /^o\d+(?:[-.\s(]|$)/.test(normalized)
  );
}

/** First-party OpenAI API hostnames: api.openai.com and its regional subdomains
 * (for example us.api.openai.com / eu.api.openai.com). Matching is exact or
 * dot-suffix so proxy hosts that merely embed the name never qualify. */
function isFirstPartyOpenAIHostname(hostname: string): boolean {
  return hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");
}

function normalizeBaseUrlHostname(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
}

/** Resolves default request flags for an OpenAI-compatible completions endpoint. */
function resolveOpenAICompletionsCompatDefaults(
  input: OpenAICompletionsCompatDefaultsInput,
): OpenAICompletionsCompatDefaults {
  const {
    provider,
    modelId,
    modelName,
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
  const baseUrlHostname = normalizeBaseUrlHostname(input.baseUrl);
  // Only first-party OpenAI and Azure OpenAI chat completions honor prompt_cache_key.
  // Other OpenAI-compatible proxies may reject the field, so it stays off by default.
  // With the inert package host every route resolves to the "default" endpoint class,
  // so the default route only counts as first-party OpenAI when no custom base URL
  // overrides the destination. First-party OpenAI hosts include the regional
  // us./eu.api.openai.com subdomains. Dedicated Azure OpenAI hosts always qualify;
  // multi-model Azure Foundry hosts only for OpenAI-family deployment ids, since
  // those resources also front non-OpenAI models (MAI, Llama, ...).
  const supportsPromptCacheKey =
    endpointClass === "openai-public" ||
    endpointClass === "azure-openai" ||
    (baseUrlHostname !== undefined && isFirstPartyOpenAIHostname(baseUrlHostname)) ||
    (isDefaultRoute &&
      isDefaultRouteProvider(provider, "openai") &&
      baseUrlHostname === undefined) ||
    (baseUrlHostname !== undefined &&
      (isDedicatedAzureOpenAIHostname(baseUrlHostname) ||
        (isAzureFoundryMultiModelHostname(baseUrlHostname) &&
          isOpenAIFamilyFoundryDeployment(modelId, modelName))));
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
      provider === "openrouter" && modelId?.startsWith("anthropic/") === true
        ? "anthropic"
        : undefined,
    sessionAffinityFormat: isOpenRouterLike ? "openrouter" : "openai",
    supportsPromptCacheKey,
    supportsLongCacheRetention:
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
    modelName?: string;
    baseUrl?: string;
  },
): OpenAICompletionsCompatDefaults {
  return resolveOpenAICompletionsCompatDefaults(input);
}

/** Detects endpoint capabilities and defaults for an OpenAI-completions model. */
export function detectOpenAICompletionsCompat(
  model: Pick<Model<"openai-completions">, "provider" | "baseUrl" | "id"> & {
    name?: string;
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
      modelName: model.name,
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
  model: Model<"openai-completions">,
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
    supportsPromptCacheKey: configured?.supportsPromptCacheKey ?? defaults.supportsPromptCacheKey,
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
