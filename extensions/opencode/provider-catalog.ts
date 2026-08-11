// Opencode Zen provider module implements model/runtime integration.
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildLiveModelProviderConfig,
  fetchLiveProviderModelIds,
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

type ZenModelCapabilities = {
  contextWindow: number;
  contextTokens?: number;
  maxTokens: number;
  input: ReadonlyArray<"text" | "image">;
  reasoningEfforts?: readonly string[];
  status?: "deprecated";
  replacedBy?: string;
};

const T = ["text"] as const;
const TI = ["text", "image"] as const;

// The official machine catalog owns limits, representable modalities, and the
// reasoning boolean. Pinned provider metadata/source owns exact effort enums.
const E_LMHXM = ["low", "medium", "high", "xhigh", "max"] as const;
const E_LMHM = ["low", "medium", "high", "max"] as const;
const E_LMH = ["low", "medium", "high"] as const;
const E_MIN_LMH = ["minimal", "low", "medium", "high"] as const;
const E_NONE_LMHX = ["none", "low", "medium", "high", "xhigh"] as const;
const E_MHX = ["medium", "high", "xhigh"] as const;
const E_NONE_LMHXM = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const E_LMHX = ["low", "medium", "high", "xhigh"] as const;
const E_NONE_LMH = ["none", "low", "medium", "high"] as const;
const E_LOW_HIGH_MAX = ["low", "high", "max"] as const;
const E_HIGH_MAX = ["high", "max"] as const;
const E_MAX = ["max"] as const;
const E_NONE_HIGH = ["none", "high"] as const;

type ZenModelMetadata = Pick<ZenModelCapabilities, "contextTokens" | "status" | "replacedBy">;

const INPUT_128 = { contextTokens: 128_000 } as const;
const INPUT_160 = { contextTokens: 160_000 } as const;
const INPUT_272 = { contextTokens: 272_000 } as const;
const INPUT_922 = { contextTokens: 922_000 } as const;
const DEPRECATED = { status: "deprecated" } as const;
const INPUT_272_DEPRECATED = { contextTokens: 272_000, status: "deprecated" } as const;
const DEPRECATED_BY_OPUS_5 = { status: "deprecated", replacedBy: "claude-opus-5" } as const;
const DEPRECATED_BY_GPT_56_SOL = {
  status: "deprecated",
  replacedBy: "gpt-5.6-sol",
} as const;
const INPUT_922_DEPRECATED_BY_GPT_56_SOL = {
  contextTokens: 922_000,
  ...DEPRECATED_BY_GPT_56_SOL,
} as const;
const DEPRECATED_BY_MINIMAX_M3 = {
  status: "deprecated",
  replacedBy: "minimax-m3",
} as const;

type ZenModelCapabilityRow = readonly [
  id: string,
  contextWindow: number,
  maxTokens: number,
  input: ReadonlyArray<"text" | "image">,
  reasoningEfforts?: readonly string[],
  metadata?: ZenModelMetadata,
];

const MODEL_CAPABILITY_ROWS = [
  ["claude-fable-5", 1000000, 128000, TI, E_LMHXM],
  ["claude-opus-5", 1000000, 128000, TI, E_LMHXM],
  ["claude-opus-4-8", 1000000, 128000, TI, E_LMHXM, DEPRECATED_BY_OPUS_5],
  ["claude-opus-4-7", 1000000, 128000, TI, E_LMHXM],
  ["claude-opus-4-6", 1000000, 128000, TI, E_LMHM],
  ["claude-opus-4-5", 200000, 64000, TI, E_LMH],
  ["claude-sonnet-5", 1000000, 128000, TI, E_LMHXM],
  ["claude-sonnet-4-6", 1000000, 64000, TI, E_LMHM],
  ["claude-sonnet-4-5", 1000000, 64000, TI],
  ["claude-sonnet-4", 1000000, 64000, TI, undefined, DEPRECATED],
  ["claude-haiku-4-5", 200000, 64000, TI],
  ["gemini-3.6-flash", 1048576, 65536, TI, E_MIN_LMH],
  ["gemini-3.5-flash-lite", 1048576, 65536, TI, E_MIN_LMH],
  ["gemini-3.5-flash", 1048576, 65536, TI, E_MIN_LMH],
  ["gemini-3.1-pro", 1048576, 65536, TI, E_LMH],
  ["gemini-3-flash", 1048576, 65536, TI, E_MIN_LMH],
  ["gpt-5.6-sol", 1050000, 128000, TI, E_NONE_LMHXM, INPUT_922],
  ["gpt-5.6-terra", 1050000, 128000, TI, E_NONE_LMHXM, INPUT_922],
  ["gpt-5.6-luna", 1050000, 128000, TI, E_NONE_LMHXM, INPUT_922],
  ["gpt-5.5", 1050000, 128000, TI, E_NONE_LMHX, INPUT_922_DEPRECATED_BY_GPT_56_SOL],
  ["gpt-5.5-pro", 1050000, 128000, TI, E_MHX, INPUT_922],
  ["gpt-5.4", 1050000, 128000, TI, E_NONE_LMHX, INPUT_922],
  ["gpt-5.4-pro", 1050000, 128000, TI, E_MHX, INPUT_922],
  ["gpt-5.4-mini", 400000, 128000, TI, E_NONE_LMHX, INPUT_272],
  ["gpt-5.4-nano", 400000, 128000, TI, E_NONE_LMHX, INPUT_272],
  ["gpt-5.3-codex-spark", 128000, 128000, T, E_LMHX, INPUT_128],
  ["gpt-5.3-codex", 400000, 128000, TI, E_NONE_LMHX, INPUT_272],
  ["gpt-5.2", 400000, 128000, TI, E_NONE_LMHX, INPUT_272],
  ["gpt-5.2-codex", 400000, 128000, TI, E_LMHX, INPUT_272_DEPRECATED],
  ["gpt-5.1", 400000, 128000, TI, E_NONE_LMH, INPUT_272],
  ["gpt-5.1-codex-max", 400000, 128000, TI, E_LMHX, INPUT_272_DEPRECATED],
  ["gpt-5.1-codex", 400000, 128000, TI, E_LMH, INPUT_272_DEPRECATED],
  ["gpt-5.1-codex-mini", 400000, 128000, TI, E_LMH, INPUT_272_DEPRECATED],
  ["gpt-5", 400000, 128000, TI, E_MIN_LMH, INPUT_272],
  ["gpt-5-codex", 400000, 128000, TI, E_LMH, INPUT_272_DEPRECATED],
  ["gpt-5-nano", 400000, 128000, TI, E_MIN_LMH, INPUT_272],
  ["grok-build-0.1", 256000, 256000, TI],
  ["grok-4.5", 500000, 500000, TI, E_LMH],
  ["deepseek-v4-pro", 1000000, 384000, T, E_HIGH_MAX],
  ["deepseek-v4-flash", 1000000, 384000, T, E_LOW_HIGH_MAX],
  ["glm-5.2", 1000000, 131072, T, E_HIGH_MAX],
  ["glm-5.1", 204800, 131072, T],
  ["glm-5", 204800, 131072, T, undefined, DEPRECATED],
  ["minimax-m3", 512000, 128000, TI],
  ["minimax-m2.7", 204800, 131072, T, undefined, DEPRECATED_BY_MINIMAX_M3],
  ["minimax-m2.5", 204800, 131072, T, undefined, DEPRECATED],
  ["kimi-k3", 1048576, 131072, TI, E_MAX],
  ["kimi-k2.7-code", 262144, 262144, TI],
  ["kimi-k2.6", 262144, 65536, TI],
  ["kimi-k2.5", 262144, 65536, TI, undefined, DEPRECATED],
  ["qwen3.6-plus", 262144, 65536, TI],
  ["qwen3.5-plus", 262144, 65536, TI],
  ["big-pickle", 200000, 32000, T, undefined, INPUT_160],
  ["deepseek-v4-flash-free", 200000, 128000, T, E_LOW_HIGH_MAX],
  ["mimo-v2.5-free", 200000, 32000, TI],
  ["ling-3.0-flash-free", 262144, 32768, T, E_LMH, DEPRECATED],
  ["ling-3.0-tiny-free", 262144, 32768, T],
  ["nemotron-3-ultra-free", 1000000, 128000, T],
  ["north-mini-code-free", 256000, 64000, T, E_NONE_HIGH],
  ["laguna-s-2.1-free", 256000, 32000, T, E_LMH],
  ["longcat-2.0-free", 1000000, 131072, T],
  ["claude-opus-4-1", 200000, 32000, TI, undefined, DEPRECATED],
] as const satisfies readonly ZenModelCapabilityRow[];
type ZenModelId = (typeof MODEL_CAPABILITY_ROWS)[number][0];

const MODEL_CAPABILITIES = Object.fromEntries(
  MODEL_CAPABILITY_ROWS.map(([id, contextWindow, maxTokens, input, reasoningEfforts, metadata]) => [
    id,
    {
      contextWindow,
      maxTokens,
      input,
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...metadata,
    },
  ]),
) as Record<string, ZenModelCapabilities>;

const MODEL_COSTS: Record<ZenModelId, ModelDefinitionConfig["cost"]> = {
  "big-pickle": FREE_COST,
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
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
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
  "gpt-5.6-luna": {
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    tieredPricing: [
      { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, range: [0, 272_000] },
      { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5, range: [272_000] },
    ],
  },
  "gpt-5.6-sol": {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    tieredPricing: [
      { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, range: [0, 272_000] },
      { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5, range: [272_000] },
    ],
  },
  "gpt-5.6-terra": {
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tieredPricing: [
      { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5, range: [0, 272_000] },
      { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5, range: [272_000] },
    ],
  },
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
    cacheRead: 0.3,
    cacheWrite: 0,
    tieredPricing: [
      { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0, range: [0, 200_000] },
      { input: 4, output: 12, cacheRead: 0.6, cacheWrite: 0, range: [200_000] },
    ],
  },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  "kimi-k2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
  "kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
  "kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  "laguna-s-2.1-free": FREE_COST,
  "ling-3.0-flash-free": FREE_COST,
  "ling-3.0-tiny-free": FREE_COST,
  "longcat-2.0-free": FREE_COST,
  "mimo-v2.5-free": FREE_COST,
  "minimax-m2.5": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
  "nemotron-3-ultra-free": FREE_COST,
  "north-mini-code-free": FREE_COST,
  "qwen3.5-plus": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "qwen3.6-plus": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
};

const MODEL_NAMES: Record<ZenModelId, string> = {
  "big-pickle": "Big Pickle",
  "claude-fable-5": "Claude Fable 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-opus-4-1": "Claude Opus 4.1",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-4": "Claude Sonnet 4",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-flash-free": "DeepSeek V4 Flash Free",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "gemini-3-flash": "Gemini 3 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro Preview",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
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
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "kimi-k3": "Kimi K3",
  "laguna-s-2.1-free": "Laguna S 2.1 Free",
  "ling-3.0-flash-free": "Ling-3.0-flash Free",
  "ling-3.0-tiny-free": "Ling-3.0-tiny Free",
  "longcat-2.0-free": "LongCat-2.0 Free",
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

type FetchOpencodeZenLiveModelIdsParams = {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

type OpencodeZenTransport = {
  api: ModelApi;
  baseUrl: string;
};

function resolveOpencodeZenTransport(modelId: string): OpencodeZenTransport {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("gpt-") || lower.startsWith("grok-")) {
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

function buildOpencodeZenModel(modelId: ZenModelId): OpencodeZenModelDefinition {
  const capabilities = MODEL_CAPABILITIES[modelId];
  if (!capabilities) {
    throw new Error(`missing OpenCode Zen capability metadata for ${modelId}`);
  }
  const transport = resolveOpencodeZenTransport(modelId);
  return normalizeModelCompat({
    id: modelId,
    name: MODEL_NAMES[modelId],
    api: transport.api,
    provider: PROVIDER_ID,
    baseUrl: transport.baseUrl,
    reasoning: true,
    input: [...capabilities.input],
    cost: MODEL_COSTS[modelId],
    contextWindow: capabilities.contextWindow,
    ...(capabilities.contextTokens ? { contextTokens: capabilities.contextTokens } : {}),
    maxTokens: capabilities.maxTokens,
    ...(transport.api === "openai-responses" && !capabilities.reasoningEfforts?.includes("none")
      ? { thinkingLevelMap: { off: null } }
      : {}),
    compat: {
      supportsUsageInStreaming: true,
      ...(capabilities.reasoningEfforts
        ? {
            supportsReasoningEffort: true,
            supportedReasoningEfforts: [...capabilities.reasoningEfforts],
          }
        : {}),
      maxTokensField: "max_tokens",
      ...(transport.api === "openai-completions"
        ? { supportsDeveloperRole: false, supportsStrictMode: false }
        : {}),
    },
  }) as OpencodeZenModelDefinition;
}

const OPENCODE_ZEN_RESOLVABLE_MODELS = MODEL_CAPABILITY_ROWS.map(([modelId]) =>
  buildOpencodeZenModel(modelId),
);
const OPENCODE_ZEN_MODELS = OPENCODE_ZEN_RESOLVABLE_MODELS.filter(
  (model) => MODEL_CAPABILITIES[model.id]?.status !== "deprecated",
);
const OPENCODE_ZEN_MODEL_BY_ID = new Map(
  OPENCODE_ZEN_RESOLVABLE_MODELS.map((model) => [model.id, model]),
);

export function buildStaticOpencodeZenProviderConfig(apiKey?: string): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    models: OPENCODE_ZEN_MODELS,
  };
}

export async function resolveOpencodeZenStarterModel(params: {
  apiKey: string;
  preferredModelRef: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const liveModelIds = await fetchLiveProviderModelIds({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_ZEN_MODELS_ENDPOINT,
    discoveryApiKey: params.apiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_ZEN_MODELS_TIMEOUT_MS,
    auditContext: "opencode-zen-onboarding-model-discovery",
  });
  const preferredModelId = params.preferredModelRef.replace(`${PROVIDER_ID}/`, "");
  return liveModelIds.includes(preferredModelId) ? params.preferredModelRef : undefined;
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

function projectOpencodeZenLiveModels(rows: readonly unknown[]): OpencodeZenModelDefinition[] {
  const staticModels = new Map(OPENCODE_ZEN_MODELS.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const models: OpencodeZenModelDefinition[] = [];
  for (const row of rows) {
    const modelId = readLiveModelId(row);
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    const model = staticModels.get(modelId);
    if (model) {
      models.push(model);
    }
  }
  return models;
}

export async function buildOpencodeZenLiveProviderConfig(
  params: FetchOpencodeZenLiveModelIdsParams = {},
): Promise<ModelProviderConfig> {
  return await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_ZEN_MODELS_ENDPOINT,
    providerConfig: {
      api: "openai-completions",
      baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL,
    },
    models: OPENCODE_ZEN_MODELS,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_ZEN_MODELS_TIMEOUT_MS,
    ttlMs: OPENCODE_ZEN_MODELS_CACHE_TTL_MS,
    auditContext: "opencode-zen-model-discovery",
    projectRows: projectOpencodeZenLiveModels,
  });
}

export function listOpencodeZenModelCatalogEntries(): ModelCatalogEntry[] {
  return OPENCODE_ZEN_RESOLVABLE_MODELS.map((model) => {
    const lifecycle = MODEL_CAPABILITIES[model.id];
    const entry: ModelCatalogEntry = {
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      contextTokens: model.contextTokens,
      compat: model.compat,
    };
    if (lifecycle?.status) {
      entry.status = lifecycle.status;
    }
    if (lifecycle?.replacedBy) {
      entry.replacedBy = lifecycle.replacedBy;
    }
    return entry;
  });
}

export function resolveOpencodeZenModel(modelId: string): ProviderRuntimeModel | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  return OPENCODE_ZEN_MODEL_BY_ID.get(normalizedModelId);
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
