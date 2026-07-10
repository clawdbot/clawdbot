// Opencode Zen provider module implements model/runtime integration.
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "opencode";

const OPENCODE_ZEN_OPENAI_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen";
const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
const OPENCODE_ZEN_MODELS_TIMEOUT_MS = 5_000;
const OPENCODE_ZEN_MODELS_CACHE_TTL_MS = 60_000;

const FREE_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Zen publishes route-specific limits that differ from the family defaults below.
const MODEL_LIMITS: Record<string, { contextWindow: number; maxTokens: number }> = {
  "claude-sonnet-5": { contextWindow: 1_000_000, maxTokens: 128_000 },
  "glm-5.2": { contextWindow: 1_000_000, maxTokens: 131_072 },
  "grok-4.5": { contextWindow: 500_000, maxTokens: 500_000 },
  "hy3-free": { contextWindow: 256_000, maxTokens: 64_000 },
  "kimi-k2.7-code": { contextWindow: 262_144, maxTokens: 262_144 },
  "minimax-m3": { contextWindow: 512_000, maxTokens: 128_000 },
};

// These rows are the inverse of their family's usual image-input capability.
const MODEL_IMAGE_INPUT_OVERRIDES = new Map<string, boolean>([
  ["hy3-free", false],
  ["minimax-m3", true],
]);

const MODEL_COSTS: Record<string, ModelDefinitionConfig["cost"]> = {
  "big-pickle": FREE_COST,
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    tieredPricing: [
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, range: [0, 200_000] },
      { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, range: [200_000] },
    ],
  },
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    tieredPricing: [
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, range: [0, 200_000] },
      { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, range: [200_000] },
    ],
  },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  "deepseek-v4-flash-free": FREE_COST,
  "deepseek-v4-pro": { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-3.1-pro": {
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 0,
    tieredPricing: [
      { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0, range: [0, 200_000] },
      { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0, range: [200_000] },
    ],
  },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
  "glm-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "gpt-5": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "gpt-5-codex": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  "gpt-5.1": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "gpt-5.1-codex": { input: 1.07, output: 8.5, cacheRead: 0.107, cacheWrite: 0 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex-spark": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4": {
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    cacheWrite: 0,
    tieredPricing: [
      { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0, range: [0, 272_000] },
      { input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0, range: [272_000] },
    ],
  },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5.4-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  "gpt-5.5": {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 0,
    tieredPricing: [
      { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, range: [0, 272_000] },
      { input: 10, output: 45, cacheRead: 1, cacheWrite: 0, range: [272_000] },
    ],
  },
  "gpt-5.5-pro": { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 },
  "grok-build-0.1": { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
  "grok-4.5": {
    input: 2,
    output: 6,
    cacheRead: 0.5,
    cacheWrite: 0,
    tieredPricing: [
      { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, range: [0, 200_000] },
      { input: 4, output: 12, cacheRead: 1, cacheWrite: 0, range: [200_000] },
    ],
  },
  "hy3-free": FREE_COST,
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  "kimi-k2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  "kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  "mimo-v2.5-free": FREE_COST,
  "minimax-m2.5": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "nemotron-3-ultra-free": FREE_COST,
  "north-mini-code-free": FREE_COST,
  "qwen3.5-plus": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "qwen3.6-plus": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
};

const MODEL_NAMES: Record<string, string> = {
  "big-pickle": "Big Pickle",
  "claude-fable-5": "Claude Fable 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-opus-4-1": "Claude Opus 4.1",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-4": "Claude Sonnet 4",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-flash-free": "DeepSeek V4 Flash Free",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "gemini-3-flash": "Gemini 3 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "glm-5": "GLM-5",
  "glm-5.1": "GLM-5.1",
  "glm-5.2": "GLM-5.2",
  "gpt-5": "GPT-5",
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5-nano": "GPT-5 Nano",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.4-nano": "GPT-5.4 Nano",
  "gpt-5.4-pro": "GPT-5.4 Pro",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.5-pro": "GPT-5.5 Pro",
  "grok-build-0.1": "Grok Build 0.1",
  "grok-4.5": "Grok 4.5",
  "hy3-free": "Hy3 Free",
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "mimo-v2.5-free": "MiMo V2.5 Free",
  "minimax-m2.5": "MiniMax M2.5",
  "minimax-m2.7": "MiniMax M2.7",
  "minimax-m3": "MiniMax M3",
  "nemotron-3-ultra-free": "Nemotron 3 Ultra Free",
  "north-mini-code-free": "North Mini Code Free",
  "qwen3.5-plus": "Qwen3.5 Plus",
  "qwen3.6-plus": "Qwen3.6 Plus",
};

type OpencodeZenModelDefinition = ModelDefinitionConfig & {
  provider: typeof PROVIDER_ID;
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  input: Array<"text" | "image">;
};

export type FetchOpencodeZenLiveModelIdsParams = {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

function formatModelName(modelId: string): string {
  const exact = MODEL_NAMES[modelId];
  if (exact) {
    return exact;
  }
  return modelId
    .split("-")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function supportsImageInput(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  const override = MODEL_IMAGE_INPUT_OVERRIDES.get(lower);
  if (override !== undefined) {
    return override;
  }
  return !(
    lower.includes("deepseek") ||
    lower.includes("glm") ||
    lower.includes("minimax") ||
    lower.includes("qwen")
  );
}

function resolveContextWindow(modelId: string): number {
  const lower = modelId.toLowerCase();
  const limits = MODEL_LIMITS[lower];
  if (limits) {
    return limits.contextWindow;
  }
  if (lower.includes("gemini")) {
    return 1_048_576;
  }
  if (lower.includes("gpt") || lower.includes("codex")) {
    return 400_000;
  }
  if (lower.includes("deepseek")) {
    return 1_000_000;
  }
  if (lower.includes("claude")) {
    return 200_000;
  }
  if (lower.includes("glm") || lower.includes("minimax")) {
    return 204_800;
  }
  if (lower.includes("kimi") || lower.includes("mimo") || lower.includes("qwen")) {
    return 262_144;
  }
  return 128_000;
}

function resolveMaxTokens(modelId: string): number {
  const lower = modelId.toLowerCase();
  const limits = MODEL_LIMITS[lower];
  if (limits) {
    return limits.maxTokens;
  }
  if (lower.includes("deepseek")) {
    return 384_000;
  }
  if (lower.includes("glm") || lower.includes("minimax")) {
    return 131_072;
  }
  if (lower.includes("gpt") || lower.includes("codex")) {
    return 128_000;
  }
  if (
    lower.includes("claude") ||
    lower.includes("gemini") ||
    lower.includes("kimi") ||
    lower.includes("qwen")
  ) {
    return 65_536;
  }
  return 8_192;
}

type OpencodeZenTransport = {
  api: ModelApi;
  baseUrl: string;
};

function resolveOpencodeZenTransport(modelId: string): OpencodeZenTransport {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gpt-")) {
    return { api: "openai-responses", baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL };
  }
  if (lower.startsWith("claude-") || lower.startsWith("qwen")) {
    return { api: "anthropic-messages", baseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL };
  }
  if (lower.startsWith("gemini-")) {
    return { api: "google-generative-ai", baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL };
  }
  return { api: "openai-completions", baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL };
}

function resolveModelCost(modelId: string): ModelDefinitionConfig["cost"] {
  const cost = MODEL_COSTS[modelId];
  if (!cost) {
    throw new Error(`missing OpenCode Zen cost metadata for ${modelId}`);
  }
  return cost;
}

function buildOpencodeZenModel(modelId: string): OpencodeZenModelDefinition {
  const normalizedModelId = modelId.trim().toLowerCase();
  const transport = resolveOpencodeZenTransport(normalizedModelId);
  return normalizeModelCompat({
    id: normalizedModelId,
    name: formatModelName(normalizedModelId),
    api: transport.api,
    provider: PROVIDER_ID,
    baseUrl: transport.baseUrl,
    reasoning: true,
    input: supportsImageInput(normalizedModelId) ? ["text", "image"] : ["text"],
    cost: resolveModelCost(normalizedModelId),
    contextWindow: resolveContextWindow(normalizedModelId),
    maxTokens: resolveMaxTokens(normalizedModelId),
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
    },
  }) as OpencodeZenModelDefinition;
}

const OPENCODE_ZEN_MODELS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4",
  "claude-haiku-4-5",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  "grok-build-0.1",
  "grok-4.5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "kimi-k2.5",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
].map(buildOpencodeZenModel);

function buildOpencodeZenProviderConfig(
  models: OpencodeZenModelDefinition[],
  apiKey?: string,
): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    models,
  };
}

export function buildStaticOpencodeZenProviderConfig(apiKey?: string): ModelProviderConfig {
  return buildOpencodeZenProviderConfig(OPENCODE_ZEN_MODELS, apiKey);
}

function readLiveModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const candidate = row as { id?: unknown; object?: unknown };
  if (candidate.object !== undefined && candidate.object !== "model") {
    return undefined;
  }
  if (typeof candidate.id !== "string") {
    return undefined;
  }
  const modelId = candidate.id.trim().toLowerCase();
  return modelId || undefined;
}

async function fetchOpencodeZenLiveModelIds(
  params: FetchOpencodeZenLiveModelIdsParams = {},
): Promise<string[]> {
  const rows = await getCachedLiveProviderModelRows({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_ZEN_MODELS_ENDPOINT,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_ZEN_MODELS_TIMEOUT_MS,
    ttlMs: OPENCODE_ZEN_MODELS_CACHE_TTL_MS,
    auditContext: "opencode-zen-model-discovery",
  });
  const seen = new Set<string>();
  const modelIds: string[] = [];
  for (const row of rows) {
    const modelId = readLiveModelId(row);
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

function buildDiscoveredOpencodeZenModels(modelIds: string[]): OpencodeZenModelDefinition[] {
  const staticModels = new Map(OPENCODE_ZEN_MODELS.map((model) => [model.id, model]));
  return modelIds.flatMap((modelId) => {
    const model = staticModels.get(modelId);
    return model ? [model] : [];
  });
}

export async function buildOpencodeZenLiveProviderConfig(
  params: FetchOpencodeZenLiveModelIdsParams = {},
): Promise<ModelProviderConfig> {
  try {
    const liveModelIds = await fetchOpencodeZenLiveModelIds(params);
    if (liveModelIds.length > 0) {
      const liveModels = buildDiscoveredOpencodeZenModels(liveModelIds);
      if (liveModels.length > 0) {
        return buildOpencodeZenProviderConfig(liveModels, params.apiKey);
      }
    }
  } catch {
    // Live discovery is advisory; keep the provider-owned static seed visible.
  }
  return buildStaticOpencodeZenProviderConfig(params.apiKey);
}

export function listOpencodeZenModelCatalogEntries(): ModelCatalogEntry[] {
  return OPENCODE_ZEN_MODELS.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
  }));
}

export function resolveOpencodeZenModel(modelId: string): ProviderRuntimeModel | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  return OPENCODE_ZEN_MODELS.find((model) => model.id === normalizedModelId);
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeOpencodeZenBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  const isAnthropicRoute = params.api === "anthropic-messages";
  if (normalized === OPENCODE_ZEN_ANTHROPIC_BASE_URL) {
    return isAnthropicRoute ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  if (normalized === OPENCODE_ZEN_OPENAI_BASE_URL) {
    return isAnthropicRoute ? OPENCODE_ZEN_ANTHROPIC_BASE_URL : OPENCODE_ZEN_OPENAI_BASE_URL;
  }
  return undefined;
}
