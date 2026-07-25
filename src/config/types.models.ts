// Defines model selection and provider configuration types.
import type {
  AnthropicMessagesCompat,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  ThinkingLevelMap,
} from "../llm/types.js";
import { isStringOption } from "../utils/string-readers.js";
import type { AgentRuntimePolicyConfig } from "./types.agents-shared.js";
import type { ConfiguredModelProviderRequest } from "./types.provider-request.js";
import type { SecretInput } from "./types.secrets.js";

/** Provider API adapter ids accepted by model/provider config and schema generation. */
export const MODEL_APIS = [
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

export type ModelApi = (typeof MODEL_APIS)[number];

type SupportedOpenAICompatFields = Pick<
  OpenAICompletionsCompat,
  | "supportsStore"
  | "supportsDeveloperRole"
  | "supportsReasoningEffort"
  | "supportsUsageInStreaming"
  | "supportsStrictMode"
  | "maxTokensField"
  | "requiresToolResultName"
  | "requiresAssistantAfterToolResult"
  | "requiresThinkingAsText"
  | "requiresReasoningContentOnAssistantMessages"
  | "openRouterRouting"
  | "vercelGatewayRouting"
  | "zaiToolStream"
  | "cacheControlFormat"
  | "sendSessionAffinityHeaders"
  | "supportsLongCacheRetention"
>;

type SupportedOpenAIResponsesCompatFields = Pick<
  OpenAIResponsesCompat,
  "sendSessionIdHeader" | "supportsLongCacheRetention" | "supportsTemperature"
>;

type SupportedAnthropicMessagesCompatFields = Pick<
  AnthropicMessagesCompat,
  "supportsEagerToolInputStreaming" | "supportsLongCacheRetention"
>;

export type SupportedThinkingFormat =
  | NonNullable<OpenAICompletionsCompat["thinkingFormat"]>
  | "deepseek"
  | "openrouter"
  | "together";

/** Thinking/reasoning payload dialects emitted by OpenAI-compatible providers. */
export const MODEL_THINKING_FORMATS = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "qwen",
  "qwen-chat-template",
  "zai",
] as const satisfies readonly SupportedThinkingFormat[];

/** Runtime guard for config-provided thinking format strings. */
export function isModelThinkingFormat(value: string): value is SupportedThinkingFormat {
  return isStringOption(value, MODEL_THINKING_FORMATS);
}

/** Provider/model compatibility switches consumed by request builders and tool schema adapters. */
export type ModelCompatConfig = SupportedOpenAICompatFields &
  SupportedOpenAIResponsesCompatFields &
  SupportedAnthropicMessagesCompatFields & {
    /** Reasoning/thinking payload dialect for provider-compatible APIs. */
    thinkingFormat?: SupportedThinkingFormat;
    /** Provider-accepted reasoning effort labels. */
    supportedReasoningEfforts?: string[];
    /** Maps OpenClaw reasoning effort labels to provider-specific labels. */
    reasoningEffortMap?: Record<string, string>;
    /** Reasoning detail block types safe to expose in visible transcripts. */
    visibleReasoningDetailTypes?: string[];
    /** Whether this model supports tool/function calling. */
    supportsTools?: boolean;
    /** Whether provider accepts prompt-cache/session affinity keys. */
    supportsPromptCacheKey?: boolean;
    /** Whether all message parts must be coerced to plain strings. */
    requiresStringContent?: boolean;
    /** Whether unknown message payload keys must be stripped before requests. */
    strictMessageKeys?: boolean;
    /** Named tool-schema profile used by provider adapters. */
    toolSchemaProfile?: string;
    /** JSON Schema keywords rejected by this provider's tool schema validator. */
    unsupportedToolSchemaKeywords?: string[];
    /** Encoding expected for tool-call arguments in provider payloads. */
    toolCallArgumentsEncoding?: string;
    /** Whether OpenAI-style calls must be reshaped to Anthropic-compatible tool payloads. */
    requiresOpenAiAnthropicToolPayload?: boolean;
  };

export type ModelImageInputConfig = {
  /** Provider-documented maximum encoded image payload size. */
  maxBytes?: number;
  /** Provider-documented maximum accepted input pixels. */
  maxPixels?: number;
  /** Provider-documented maximum accepted width/height in pixels. */
  maxSidePx?: number;
  /** Preferred resize side for the default balanced compression policy. */
  preferredSidePx?: number;
  /** Token accounting style, used as documentation for provider-owned policy. */
  tokenMode?: "tile" | "detail" | "provider";
};

export type ModelMediaInputConfig = {
  /** Image input limits and accounting hints for this model. */
  image?: ModelImageInputConfig;
};

/** Authentication mode expected by a configured model provider. */
export type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";

export type ModelProviderLocalServiceConfig = {
  /** Executable started before model requests are sent. */
  command: string;
  /** Arguments passed without shell expansion. */
  args?: string[];
  /** Working directory for the local service process. */
  cwd?: string;
  /** Environment variables added to the service process. */
  env?: Record<string, string>;
  /** Optional health endpoint polled before the provider is considered ready. */
  healthUrl?: string;
  /** Startup readiness timeout in milliseconds. */
  readyTimeoutMs?: number;
  /** Idle timeout in milliseconds before stopping the local service. */
  idleStopMs?: number;
};

export type ModelDefinitionConfig = {
  /** Provider-facing model id. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Optional API adapter override for this model. */
  api?: ModelApi;
  /** Optional base URL override for this model. */
  baseUrl?: string;
  /** Whether the model supports reasoning/thinking controls. */
  reasoning: boolean;
  /** Supported input modalities for routing and media-tool selection. */
  input: Array<"text" | "image" | "video" | "audio">;
  /** Token pricing in USD per million tokens. */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Optional tiered pricing.  When present, cost calculation uses
     *  per-tier rates instead of the flat rates above.  Prices are
     *  USD / million tokens; ranges are half-open `[start, end)` on the
     *  input-token axis. */
    tieredPricing?: Array<{
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      /** Bounded tier: `[start, end)`. Open-ended top tier: `[start]` (normalized to `[start, Infinity]` at load time). */
      range: [number, number] | [number];
    }>;
  };
  /** Provider/native maximum context window in tokens. */
  contextWindow: number;
  /**
   * Optional effective runtime cap used for compaction/session budgeting.
   * Keeps provider/native contextWindow metadata intact while letting configs
   * prefer a smaller practical window.
   */
  contextTokens?: number;
  /** Maximum completion/output token budget. */
  maxTokens: number;
  /** Maps OpenClaw thinking levels to provider/model-specific values. */
  thinkingLevelMap?: ThinkingLevelMap;
  /** Provider-specific request/runtime parameters passed through to provider plugins. */
  params?: Record<string, unknown>;
  /** Optional agent execution runtime override for this provider/model pair. */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** Static headers merged into requests for this model. */
  headers?: Record<string, string>;
  /** Provider compatibility flags for payload shaping and feature gating. */
  compat?: ModelCompatConfig;
  /** Media input limits used by routing and preflight compression. */
  mediaInput?: ModelMediaInputConfig;
  /** Metadata source marker for models added by CLI/catalog tooling. */
  metadataSource?: "models-add";
};

export type ModelProviderConfig = {
  /** Provider API base URL. */
  baseUrl: string;
  /** API key or secret reference for this provider. */
  apiKey?: SecretInput;
  /** Authentication mode used when resolving credentials for this provider. */
  auth?: ModelProviderAuthMode;
  /** Default API adapter for models under this provider. */
  api?: ModelApi;
  /** Provider-level default context window. */
  contextWindow?: number;
  /** Provider-level effective runtime context cap. */
  contextTokens?: number;
  /** Provider-level default max output tokens. */
  maxTokens?: number;
  /** Provider request timeout in seconds. */
  timeoutSeconds?: number;
  /** Optional provider deployment/API region used by provider plugins that expose regional endpoints. */
  region?: string;
  injectNumCtxForOpenAICompat?: boolean;
  /** Provider-specific runtime parameters interpreted by provider plugins. */
  params?: Record<string, unknown>;
  /** Optional default agent execution runtime for models under this provider. */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** Optional local service to start before calling this provider. */
  localService?: ModelProviderLocalServiceConfig;
  /** Secret-bearing headers merged into provider requests. */
  headers?: Record<string, SecretInput>;
  /** Whether default Authorization header injection is enabled. */
  authHeader?: boolean;
  /** Provider request transport/retry overrides. */
  request?: ConfiguredModelProviderRequest;
  /** Model catalog entries exposed by this provider. */
  models: ModelDefinitionConfig[];
};

/** Fully materialized provider declaration emitted by provider catalog plugins. */
export type ModelProviderDeclarationConfig = ModelProviderConfig;

/** User config input shape before provider defaults/models are materialized. */
export type ModelProviderConfigInput = Omit<Partial<ModelProviderConfig>, "models"> & {
  models?: ModelDefinitionConfig[];
};

export type BedrockDiscoveryConfig = {
  /** Enable AWS Bedrock model discovery. */
  enabled?: boolean;
  /** AWS region to query for models. */
  region?: string;
  /** Optional provider id filters for discovery. */
  providerFilter?: string[];
  /** Discovery cache refresh interval in seconds. */
  refreshInterval?: number;
  /** Context window applied when discovery cannot infer one. */
  defaultContextWindow?: number;
  /** Max output tokens applied when discovery cannot infer one. */
  defaultMaxTokens?: number;
};

export type DiscoveryToggleConfig = {
  /** Enables the named discovery source. */
  enabled?: boolean;
};

export type ModelPricingConfig = {
  /** Enable external or generated pricing enrichment. */
  enabled?: boolean;
};

export type ModelsConfig = {
  /** Merge provider config with bundled catalogs or replace bundled catalogs entirely. */
  mode?: "merge" | "replace";
  /** Configured provider catalog keyed by provider id. */
  providers?: Record<string, ModelProviderConfig>;
  /** Pricing enrichment settings. */
  pricing?: ModelPricingConfig;
};

/** Top-level models config input before provider entries are normalized. */
export type ModelsConfigInput = Omit<ModelsConfig, "providers"> & {
  providers?: Record<string, ModelProviderConfigInput>;
};
