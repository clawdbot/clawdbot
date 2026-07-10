// Shared model catalog data contracts for provider manifests and normalized rows.

/** Supported API protocols for model catalog entries. */
export const MODEL_CATALOG_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
  "azure-openai-responses",
] as const;

/** API protocol for a model catalog entry. */
export type ModelCatalogApi = (typeof MODEL_CATALOG_APIS)[number];

/** Supported model thinking/reasoning wire formats. */
export const MODEL_CATALOG_THINKING_FORMATS = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "qwen",
  "qwen-chat-template",
  "zai",
] as const;

/** Thinking/reasoning wire format for model compatibility. */
export type ModelCatalogThinkingFormat = (typeof MODEL_CATALOG_THINKING_FORMATS)[number];

/** Narrow a string to a supported model catalog thinking format. */
export function isModelCatalogThinkingFormat(value: string): value is ModelCatalogThinkingFormat {
  return (MODEL_CATALOG_THINKING_FORMATS as readonly string[]).includes(value);
}

/** Compatibility flags and provider-specific routing metadata for one model. */
export type ModelCatalogCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  /** Whether the model accepts the temperature parameter (GPT-5.6 family rejects it). */
  supportsTemperature?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  openRouterRouting?: ModelCatalogOpenRouterRouting;
  vercelGatewayRouting?: ModelCatalogVercelGatewayRouting;
  zaiToolStream?: boolean;
  cacheControlFormat?: "anthropic";
  sendSessionAffinityHeaders?: boolean;
  sendSessionIdHeader?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsTools?: boolean;
  requiresStringContent?: boolean;
  strictMessageKeys?: boolean;
  toolSchemaProfile?: string;
  unsupportedToolSchemaKeywords?: string[];
  nativeWebSearchTool?: boolean;
  toolCallArgumentsEncoding?: string;
  requiresMistralToolIds?: boolean;
  requiresOpenAiAnthropicToolPayload?: boolean;
  thinkingFormat?: ModelCatalogThinkingFormat;
  supportedReasoningEfforts?: string[];
  reasoningEffortMap?: Record<string, string>;
  visibleReasoningDetailTypes?: string[];
};

/** OpenRouter routing preferences copied into request metadata. */
export type ModelCatalogOpenRouterRouting = {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "deny" | "allow";
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?:
    | string
    | {
        by?: string;
        partition?: string | null;
      };
  max_price?: {
    prompt?: number | string;
    completion?: number | string;
    image?: number | string;
    audio?: number | string;
    request?: number | string;
  };
  preferred_min_throughput?:
    | number
    | {
        p50?: number;
        p75?: number;
        p90?: number;
        p99?: number;
      };
  preferred_max_latency?:
    | number
    | {
        p50?: number;
        p75?: number;
        p90?: number;
        p99?: number;
      };
};

/** Vercel AI Gateway routing preferences. */
export type ModelCatalogVercelGatewayRouting = {
  only?: string[];
  order?: string[];
};

/** Image input limits for a model. */
export type ModelCatalogImageInputConfig = {
  maxBytes?: number;
  maxPixels?: number;
  maxSidePx?: number;
  preferredSidePx?: number;
  tokenMode?: "tile" | "detail" | "provider";
};

/** Media input limits for a model. */
export type ModelCatalogMediaInputConfig = {
  image?: ModelCatalogImageInputConfig;
};

/** Supported input modality for a model. */
export type ModelCatalogInput = "text" | "image" | "document";
/** Model-level thinking settings carried by provider catalog metadata. */
export const MODEL_CATALOG_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ModelCatalogThinkingLevel = (typeof MODEL_CATALOG_THINKING_LEVELS)[number];
export type ModelCatalogThinkingLevelMap = Partial<
  Record<ModelCatalogThinkingLevel, string | null>
>;
/** Discovery lifecycle for a provider catalog. */
export type ModelCatalogDiscovery = "static" | "refreshable" | "runtime";
/** Availability state for a model. */
export type ModelCatalogStatus = "available" | "preview" | "deprecated" | "disabled";
/** Source of a model catalog row. */
export type ModelCatalogSource =
  | "manifest"
  | "provider-index"
  | "cache"
  | "config"
  | "runtime-refresh";

/** Unified catalog kind across text and generated media models. */
export type UnifiedModelCatalogKind =
  | "text"
  | "voice"
  | "image_generation"
  | "video_generation"
  | "music_generation";

/** Source for unified model catalog entries. */
export type UnifiedModelCatalogSource =
  | "manifest"
  | "provider-index"
  | "static"
  | "live"
  | "cache"
  | "configured"
  | "runtime-refresh";

/** Unified model catalog entry for provider/model pickers. */
export type UnifiedModelCatalogEntry<TCapabilities = unknown> = {
  kind: UnifiedModelCatalogKind;
  provider: string;
  model: string;
  label?: string;
  source: UnifiedModelCatalogSource;
  default?: boolean;
  configured?: boolean;
  capabilities?: TCapabilities;
  modes?: readonly string[];
  authEnvVars?: readonly string[];
  docsPath?: string;
  fetchedAt?: number;
  expiresAt?: number;
  warnings?: readonly string[];
};

/** Tiered token cost row. */
export type ModelCatalogTieredCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  range: [number, number] | [number];
};

/** Token cost metadata for one model. */
export type ModelCatalogCost = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tieredPricing?: ModelCatalogTieredCost[];
};

/** Provider manifest model entry. */
export type ModelCatalogModel = {
  id: string;
  name?: string;
  api?: ModelCatalogApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  input?: ModelCatalogInput[];
  reasoning?: boolean;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  thinkingLevelMap?: ModelCatalogThinkingLevelMap;
  cost?: ModelCatalogCost;
  compat?: ModelCatalogCompatConfig;
  mediaInput?: ModelCatalogMediaInputConfig;
  status?: ModelCatalogStatus;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
  tags?: string[];
};

/** Provider manifest catalog entry. */
export type ModelCatalogProvider = {
  baseUrl?: string;
  api?: ModelCatalogApi;
  headers?: Record<string, string>;
  /** Provider-recommended small model id for short internal utility tasks. */
  defaultUtilityModel?: string;
  models: ModelCatalogModel[];
};

/** Provider alias entry. */
export type ModelCatalogAlias = {
  provider: string;
  api?: ModelCatalogApi;
  baseUrl?: string;
};

/** Suppression rule for hiding a provider/model under matching config. */
export type ModelCatalogSuppression = {
  provider: string;
  model: string;
  reason?: string;
  when?: {
    baseUrlHosts?: string[];
    providerConfigApiIn?: string[];
  };
};

/** Raw model catalog manifest shape. */
export type ModelCatalog = {
  providers?: Record<string, ModelCatalogProvider>;
  aliases?: Record<string, ModelCatalogAlias>;
  suppressions?: ModelCatalogSuppression[];
  discovery?: Record<string, ModelCatalogDiscovery>;
  runtimeAugment?: boolean;
};

/** Normalized model catalog row used by runtime lookup and UI surfaces. */
export type NormalizedModelCatalogRow = {
  provider: string;
  id: string;
  ref: string;
  mergeKey: string;
  name: string;
  source: ModelCatalogSource;
  input: ModelCatalogInput[];
  reasoning: boolean;
  status: ModelCatalogStatus;
  api?: ModelCatalogApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  thinkingLevelMap?: ModelCatalogThinkingLevelMap;
  cost?: ModelCatalogCost;
  compat?: ModelCatalogCompatConfig;
  mediaInput?: ModelCatalogMediaInputConfig;
  statusReason?: string;
  replaces?: string[];
  replacedBy?: string;
  tags?: string[];
};
