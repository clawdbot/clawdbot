import type { OpenAICompletionsCompat } from "@mariozechner/pi-ai";
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
>;

type SupportedThinkingFormat =
  | NonNullable<OpenAICompletionsCompat["thinkingFormat"]>
  | "openrouter"
  | "qwen-chat-template";

export type ModelCompatConfig = SupportedOpenAICompatFields & {
  thinkingFormat?: SupportedThinkingFormat;
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
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  /**
   * Optional effective runtime cap used for compaction/session budgeting.
   * Keeps provider/native contextWindow metadata intact while letting configs
   * prefer a smaller practical window.
   */
  contextTokens?: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: SecretInput;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  injectNumCtxForOpenAICompat?: boolean;
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

export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
  // Deprecated legacy compat aliases. Kept in the runtime type surface so
  // doctor/runtime fallbacks can read older configs until migration completes.
  bedrockDiscovery?: BedrockDiscoveryConfig;
  copilotDiscovery?: DiscoveryToggleConfig;
  huggingfaceDiscovery?: DiscoveryToggleConfig;
  ollamaDiscovery?: DiscoveryToggleConfig;
};
