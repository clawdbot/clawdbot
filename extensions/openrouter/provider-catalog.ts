// Openrouter provider module implements model/runtime integration.
import {
  buildLiveModelProviderConfig,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS_ENDPOINT = `${OPENROUTER_BASE_URL}/models`;
const OPENROUTER_LEGACY_BASE_URL = "https://openrouter.ai/v1";
const OPENROUTER_MODELS_CACHE_TTL_MS = 60_000;
const OPENROUTER_DEFAULT_MODEL_ID = "openrouter/auto";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 200000;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const OPENROUTER_PROXY_REASONING_UNSUPPORTED_MODEL_IDS = new Set(["openrouter/hunter-alpha"]);
const OPENROUTER_KIMI_K2_6_COST = {
  input: 0.8,
  output: 3.5,
  cacheRead: 0.2,
  cacheWrite: 0,
};
const OPENROUTER_KIMI_K2_5_COST = {
  input: 0.44,
  output: 2,
  cacheRead: 0.22,
  cacheWrite: 0,
};

export function normalizeOpenRouterBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = baseUrl?.trim().replace(/\/+$/, "");
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENROUTER_BASE_URL || normalized === OPENROUTER_LEGACY_BASE_URL) {
    return OPENROUTER_BASE_URL;
  }
  return undefined;
}

export function isOpenRouterProxyReasoningUnsupportedModel(modelId: string | undefined): boolean {
  const normalized = (modelId ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    OPENROUTER_PROXY_REASONING_UNSUPPORTED_MODEL_IDS.has(normalized) ||
    normalized.startsWith("openrouter/hunter-alpha:")
  );
}

export function buildOpenrouterProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: OPENROUTER_DEFAULT_MODEL_ID,
        name: "OpenRouter Auto",
        reasoning: false,
        input: ["text", "image"],
        cost: OPENROUTER_DEFAULT_COST,
        contextWindow: OPENROUTER_DEFAULT_CONTEXT_WINDOW,
        maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS,
      },
      {
        id: "moonshotai/kimi-k2.6",
        name: "MoonshotAI: Kimi K2.6",
        reasoning: true,
        input: ["text", "image"],
        cost: OPENROUTER_KIMI_K2_6_COST,
        contextWindow: 262144,
        maxTokens: 262144,
      },
      {
        id: "moonshotai/kimi-k2.5",
        name: "MoonshotAI: Kimi K2.5",
        reasoning: true,
        input: ["text", "image"],
        cost: OPENROUTER_KIMI_K2_5_COST,
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
  };
}

function readStringArray(record: Record<string, unknown> | undefined, key: string): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readTokenPrice(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : 0;
}

function readOpenRouterModalities(
  architecture: Record<string, unknown> | undefined,
  direction: "input" | "output",
): string[] {
  const explicit = readStringArray(architecture, `${direction}_modalities`);
  if (explicit.length > 0) {
    return explicit;
  }
  const modality = normalizeOptionalString(architecture?.modality);
  if (!modality) {
    return [];
  }
  const [input = "", output = ""] = modality.split("->", 2);
  return (direction === "input" ? input : output).split("+").filter(Boolean);
}

function buildOpenRouterLiveModel(row: unknown): ModelDefinitionConfig | undefined {
  const record = asOptionalRecord(row);
  const id = normalizeOptionalString(record?.id);
  const architecture = asOptionalRecord(record?.architecture);
  const outputModalities = readOpenRouterModalities(architecture, "output");
  if (!id || (outputModalities.length > 0 && !outputModalities.includes("text"))) {
    return undefined;
  }
  const inputModalities = readOpenRouterModalities(architecture, "input");
  const supportedParameters = readStringArray(record, "supported_parameters");
  const topProvider = asOptionalRecord(record?.top_provider);
  const pricing = asOptionalRecord(record?.pricing);
  return {
    id,
    name: normalizeOptionalString(record?.name) ?? id,
    reasoning:
      supportedParameters.includes("reasoning") ||
      supportedParameters.includes("include_reasoning"),
    input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: {
      input: readTokenPrice(pricing, "prompt"),
      output: readTokenPrice(pricing, "completion"),
      cacheRead: readTokenPrice(pricing, "input_cache_read"),
      cacheWrite: readTokenPrice(pricing, "input_cache_write"),
    },
    contextWindow:
      asPositiveSafeInteger(topProvider?.context_length) ??
      asPositiveSafeInteger(record?.context_length) ??
      OPENROUTER_DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      asPositiveSafeInteger(topProvider?.max_completion_tokens) ??
      asPositiveSafeInteger(record?.max_completion_tokens) ??
      asPositiveSafeInteger(record?.max_output_tokens) ??
      OPENROUTER_DEFAULT_MAX_TOKENS,
  };
}

export async function buildOpenrouterLiveProvider(params: {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  const fallback = buildOpenrouterProvider();
  return await buildLiveModelProviderConfig({
    providerId: "openrouter",
    endpoint: OPENROUTER_MODELS_ENDPOINT,
    providerConfig: {
      baseUrl: fallback.baseUrl,
      api: fallback.api,
    },
    models: fallback.models,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    ttlMs: OPENROUTER_MODELS_CACHE_TTL_MS,
    auditContext: "openrouter-model-discovery",
    projectRows: (rows, fallbackProvider) => {
      const liveModels = rows.flatMap((row) => {
        const model = buildOpenRouterLiveModel(row);
        return model ? [model] : [];
      });
      if (liveModels.length === 0) {
        return [];
      }
      return [
        ...new Map(
          [...fallbackProvider.models, ...liveModels].map((model) => [model.id, model]),
        ).values(),
      ].toSorted((a, b) => a.id.localeCompare(b.id));
    },
  });
}
