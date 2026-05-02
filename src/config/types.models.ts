import type {
  AnthropicMessagesCompat,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
} from "@mariozechner/pi-ai";
import type { ConfiguredModelProviderRequest } from "./types.provider-request.js";
import type { SecretInput } from "./types.secrets.js";

export const MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
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
  | "openRouterRouting"
  | "vercelGatewayRouting"
  | "zaiToolStream"
  | "cacheControlFormat"
  | "sendSessionAffinityHeaders"
  | "supportsLongCacheRetention"
>;

type SupportedOpenAIResponsesCompatFields = Pick<
  OpenAIResponsesCompat,
  "sendSessionIdHeader" | "supportsLongCacheRetention"
>;

type SupportedAnthropicMessagesCompatFields = Pick<
  AnthropicMessagesCompat,
  "supportsEagerToolInputStreaming" | "supportsLongCacheRetention"
>;

type SupportedThinkingFormat =
  | Exclude<NonNullable<OpenAICompletionsCompat["thinkingFormat"]>, "qwen" | "qwen-chat-template">
  | "deepseek"
  | "openrouter";

export type ModelCompatConfig = SupportedOpenAICompatFields &
  SupportedOpenAIResponsesCompatFields &
  SupportedAnthropicMessagesCompatFields & {
    thinkingFormat?: SupportedThinkingFormat;
    supportedReasoningEfforts?: string[];
    reasoningEffortMap?: Record<string, string>;
    visibleReasoningDetailTypes?: string[];
    supportsTools?: boolean;
    supportsPromptCacheKey?: boolean;
    requiresStringContent?: boolean;
    toolSchemaProfile?: string;
    unsupportedToolSchemaKeywords?: string[];
    nativeWebSearchTool?: boolean;
    toolCallArgumentsEncoding?: string;
    requiresMistralToolIds?: boolean;
    requiresOpenAiAnthropicToolPayload?: boolean;
  };

export type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  baseUrl?: string;
  reasoning: boolean;
  input: Array<"text" | "image" | "video" | "audio">;
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
  contextWindow: number;
  /**
   * Optional effective runtime cap used for compaction/session budgeting.
   * Keeps provider/native contextWindow metadata intact while letting configs
   * prefer a smaller practical window.
   */
  contextTokens?: number;
  maxTokens: number;
  /** Provider-specific request/runtime parameters passed through to provider plugins. */
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
  metadataSource?: "models-add";
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: SecretInput;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  injectNumCtxForOpenAICompat?: boolean;
  /** Provider-specific runtime parameters interpreted by provider plugins. */
  params?: Record<string, unknown>;
  headers?: Record<string, SecretInput>;
  authHeader?: boolean;
  request?: ConfiguredModelProviderRequest;
  models: ModelDefinitionConfig[];
};

export type BedrockDiscoveryConfig = {
  enabled?: boolean;
  region?: string;
  providerFilter?: string[];
  refreshInterval?: number;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
};

export type DiscoveryToggleConfig = {
  enabled?: boolean;
};

export type ModelPricingConfig = {
  enabled?: boolean;
};

export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
  pricing?: ModelPricingConfig;
  /**
   * @deprecated Legacy compat alias. Kept so doctor/runtime fallbacks can read
   * older configs until migration completes.
   */
  bedrockDiscovery?: BedrockDiscoveryConfig;
  /**
   * @deprecated Legacy compat alias. Kept so doctor/runtime fallbacks can read
   * older configs until migration completes.
   */
  copilotDiscovery?: DiscoveryToggleConfig;
  /**
   * @deprecated Legacy compat alias. Kept so doctor/runtime fallbacks can read
   * older configs until migration completes.
   */
  huggingfaceDiscovery?: DiscoveryToggleConfig;
  /**
   * @deprecated Legacy compat alias. Kept so doctor/runtime fallbacks can read
   * older configs until migration completes.
   */
  ollamaDiscovery?: DiscoveryToggleConfig;
};
