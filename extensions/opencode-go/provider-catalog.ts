// Opencode Go provider module implements model/runtime integration.
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildLiveModelProviderConfig,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "opencode-go";

const OPENCODE_GO_OPENAI_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";
const OPENCODE_GO_KIMI_NO_REASONING_MODEL_IDS = new Set([
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
]);
const OPENCODE_GO_MODELS_ENDPOINT = "https://opencode.ai/zen/go/v1/models";
const OPENCODE_GO_MODELS_TIMEOUT_MS = 5_000;
const OPENCODE_GO_MODELS_CACHE_TTL_MS = 60_000;
// OpenCode Go exposes only high/max provider effort for DeepSeek V4. Lower
// OpenClaw levels retain their existing high-effort behavior.
const OPENCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

type OpencodeGoModelDefinition = ModelDefinitionConfig & {
  provider: typeof PROVIDER_ID;
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  input: Array<"text" | "image">;
};

const OPENCODE_GO_MODELS = (
  [
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      thinkingLevelMap: OPENCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_MAP,
      input: ["text"],
      cost: {
        input: 1.74,
        output: 3.48,
        cacheRead: 0.145,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    },
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      thinkingLevelMap: OPENCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_MAP,
      input: ["text"],
      cost: {
        input: 0.14,
        output: 0.28,
        cacheRead: 0.028,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    },
    {
      id: "grok-4.5",
      name: "Grok 4.5",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 2.0,
        output: 6.0,
        cacheRead: 0.3,
        cacheWrite: 0,
      },
      contextWindow: 500_000,
      maxTokens: 128_000,
    },
    {
      id: "glm-5",
      name: "GLM-5",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 1,
        output: 3.2,
        cacheRead: 0.2,
        cacheWrite: 0,
      },
      contextWindow: 202_752,
      maxTokens: 32_768,
    },
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 1.4,
        output: 4.4,
        cacheRead: 0.26,
        cacheWrite: 0,
      },
      contextWindow: 202_752,
      maxTokens: 32_768,
    },
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 1.4,
        output: 4.4,
        cacheRead: 0.26,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    },
    {
      id: "hy3-preview",
      name: "HY3 Preview",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 262_144,
      maxTokens: 32_768,
    },
    {
      id: "hy3",
      name: "HY3",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.14,
        output: 0.58,
        cacheRead: 0.035,
        cacheWrite: 0,
      },
      contextWindow: 262_144,
      maxTokens: 131_072,
    },
    {
      id: "kimi-k2.5",
      name: "Kimi K2.5",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.6,
        output: 3,
        cacheRead: 0.1,
        cacheWrite: 0,
      },
      contextWindow: 262_144,
      maxTokens: 65_536,
    },
    {
      id: "kimi-k2.6",
      name: "Kimi K2.6",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.95,
        output: 4,
        cacheRead: 0.16,
        cacheWrite: 0,
      },
      contextWindow: 262_144,
      maxTokens: 65_536,
    },
    {
      id: "kimi-k2.7-code",
      name: "Kimi K2.7 Code",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.95,
        output: 4,
        cacheRead: 0.19,
        cacheWrite: 0,
      },
      contextWindow: 262_144,
      maxTokens: 262_144,
    },
    {
      id: "kimi-k3",
      name: "Kimi K3",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 3.0,
        output: 15.0,
        cacheRead: 0.3,
        cacheWrite: 0,
      },
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    },
    {
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.4,
        output: 2,
        cacheRead: 0.08,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: "mimo-v2.5-pro",
      name: "MiMo V2.5 Pro",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 1,
        output: 3,
        cacheRead: 0.2,
        cacheWrite: 0,
      },
      contextWindow: 1_048_576,
      maxTokens: 128_000,
    },
    {
      id: "minimax-m2.5",
      name: "MiniMax M2.5",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.03,
        cacheWrite: 0.375,
      },
      contextWindow: 204_800,
      maxTokens: 65_536,
    },
    {
      id: "minimax-m2.7",
      name: "MiniMax M2.7",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.3,
        output: 1.2,
        cacheRead: 0.06,
        cacheWrite: 0.375,
      },
      contextWindow: 204_800,
      maxTokens: 131_072,
    },
    {
      id: "minimax-m3",
      name: "MiniMax M3",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.6,
        output: 2.4,
        cacheRead: 0.12,
        cacheWrite: 0.75,
      },
      contextWindow: 204_800,
      maxTokens: 131_072,
    },
    {
      id: "qwen3.5-plus",
      name: "Qwen3.5 Plus",
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
      compat: { thinkingFormat: "qwen" },
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.2,
        output: 1.2,
        cacheRead: 0.02,
        cacheWrite: 0.25,
      },
      contextWindow: 262_144,
      maxTokens: 65_536,
    },
    {
      id: "qwen3.7-max",
      name: "Qwen3.7 Max",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      compat: { thinkingFormat: "qwen" },
      reasoning: true,
      input: ["text"],
      cost: {
        input: 2.5,
        output: 7.5,
        cacheRead: 0.5,
        cacheWrite: 3.125,
      },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    },
    {
      id: "qwen3.7-plus",
      name: "Qwen3.7 Plus",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      compat: { thinkingFormat: "qwen" },
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.4,
        output: 1.6,
        cacheRead: 0.04,
        cacheWrite: 0.5,
      },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    },
    {
      id: "qwen3.6-plus",
      name: "Qwen3.6 Plus",
      api: "anthropic-messages",
      provider: PROVIDER_ID,
      baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
      compat: { thinkingFormat: "qwen" },
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.5,
        output: 3,
        cacheRead: 0.05,
        cacheWrite: 0.625,
      },
      contextWindow: 262_144,
      maxTokens: 65_536,
    },
  ] satisfies OpencodeGoModelDefinition[]
).map((model) => normalizeModelCompat(model) as OpencodeGoModelDefinition);

type FetchOpencodeGoLiveModelIdsParams = {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

function buildOpencodeGoProviderConfig(
  models: OpencodeGoModelDefinition[],
  apiKey?: string,
): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    models,
  };
}

export function buildStaticOpencodeGoProviderConfig(apiKey?: string): ModelProviderConfig {
  return buildOpencodeGoProviderConfig(OPENCODE_GO_MODELS, apiKey);
}

export async function buildOpencodeGoLiveProviderConfig(
  params: FetchOpencodeGoLiveModelIdsParams = {},
): Promise<ModelProviderConfig> {
  return await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_GO_MODELS_ENDPOINT,
    providerConfig: {
      api: "openai-completions",
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    },
    models: OPENCODE_GO_MODELS,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_GO_MODELS_TIMEOUT_MS,
    ttlMs: OPENCODE_GO_MODELS_CACHE_TTL_MS,
    auditContext: "opencode-go-model-discovery",
  });
}

export function listOpencodeGoModelCatalogEntries(): ModelCatalogEntry[] {
  return OPENCODE_GO_MODELS.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
  }));
}

export function resolveOpencodeGoModel(modelId: string): ProviderRuntimeModel | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  return OPENCODE_GO_MODELS.find((model) => model.id === normalizedModelId);
}

export function isOpencodeGoKimiNoReasoningModelId(modelId: unknown): boolean {
  return (
    typeof modelId === "string" &&
    OPENCODE_GO_KIMI_NO_REASONING_MODEL_IDS.has(modelId.trim().toLowerCase())
  );
}

export function normalizeOpencodeGoResolvedModel(
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  if (!isOpencodeGoKimiNoReasoningModelId(model.id)) {
    return undefined;
  }
  const compat =
    model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
      ? model.compat
      : undefined;
  if (!model.reasoning && !compat?.supportsReasoningEffort) {
    return undefined;
  }
  return {
    ...model,
    reasoning: false,
    compat: {
      ...compat,
      supportsReasoningEffort: false,
    },
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeOpencodeGoBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENCODE_GO_OPENAI_BASE_URL) {
    return OPENCODE_GO_OPENAI_BASE_URL;
  }
  if (normalized === OPENCODE_GO_ANTHROPIC_BASE_URL) {
    return OPENCODE_GO_ANTHROPIC_BASE_URL;
  }
  if (normalized === "https://opencode.ai/go") {
    return OPENCODE_GO_ANTHROPIC_BASE_URL;
  }
  if (normalized === "https://opencode.ai/go/v1") {
    return params.api === "anthropic-messages"
      ? OPENCODE_GO_ANTHROPIC_BASE_URL
      : OPENCODE_GO_OPENAI_BASE_URL;
  }
  return undefined;
}
