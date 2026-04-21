import {
  applyProviderNativeStreamingUsageCompat,
  supportsNativeStreamingUsageCompat,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
export const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.6";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 262144;
const MOONSHOT_DEFAULT_MAX_TOKENS = 262144;
const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const MOONSHOT_K2_6_COST = {
  input: 0.95,
  output: 4,
  cacheRead: 0.16,
  cacheWrite: 0,
};
const MOONSHOT_K2_5_COST = {
  input: 0.6,
  output: 3,
  cacheRead: 0.1,
  cacheWrite: 0,
};

const MOONSHOT_MODEL_CATALOG = [
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: false,
    input: ["text", "image"],
    cost: MOONSHOT_K2_6_COST,
    contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text", "image"],
    cost: MOONSHOT_K2_5_COST,
    contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: true,
    input: ["text"],
    cost: MOONSHOT_DEFAULT_COST,
    contextWindow: 262144,
    maxTokens: 262144,
  },
  {
    id: "kimi-k2-thinking-turbo",
    name: "Kimi K2 Thinking Turbo",
    reasoning: true,
    input: ["text"],
    cost: MOONSHOT_DEFAULT_COST,
    contextWindow: 262144,
    maxTokens: 262144,
  },
  {
    id: "kimi-k2-turbo",
    name: "Kimi K2 Turbo",
    reasoning: false,
    input: ["text"],
    cost: MOONSHOT_DEFAULT_COST,
    contextWindow: 256000,
    maxTokens: 16384,
  },
] as const;

export function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  return supportsNativeStreamingUsageCompat({
    providerId: "moonshot",
    baseUrl,
  });
}

export function applyMoonshotNativeStreamingUsageCompat(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  return applyProviderNativeStreamingUsageCompat({
    providerId: "moonshot",
    providerConfig: provider,
  });
}

export function buildMoonshotProvider(): ModelProviderConfig {
  return {
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    models: MOONSHOT_MODEL_CATALOG.map((model) =>
      Object.assign({}, model, { input: [...model.input] }),
    ),
  };
}
