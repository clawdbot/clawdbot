import {
  applyProviderNativeStreamingUsageCompat,
  supportsNativeStreamingUsageCompat,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const QWEN_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
export const QWEN_GLOBAL_BASE_URL = QWEN_BASE_URL;
export const QWEN_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
export const QWEN_STANDARD_CN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const QWEN_STANDARD_GLOBAL_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export const QWEN_DEFAULT_MODEL_ID = "qwen3.5-plus";
export const QWEN_36_PLUS_MODEL_ID = "qwen3.6-plus";
export const QWEN_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const QWEN_DEFAULT_MODEL_REF = `qwen/${QWEN_DEFAULT_MODEL_ID}`;

export const QWEN_MODEL_CATALOG: ReadonlyArray<ModelDefinitionConfig> = [
  {
    id: "qwen3.5-plus",
    name: "qwen3.5-plus",
    reasoning: false,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: QWEN_36_PLUS_MODEL_ID,
    name: QWEN_36_PLUS_MODEL_ID,
    reasoning: false,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "qwen3-max-2026-01-23",
    name: "qwen3-max-2026-01-23",
    reasoning: false,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 65_536,
  },
  {
    id: "qwen3-coder-next",
    name: "qwen3-coder-next",
    reasoning: false,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 65_536,
  },
  {
    id: "qwen3-coder-plus",
    name: "qwen3-coder-plus",
    reasoning: false,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "MiniMax-M2.5",
    name: "MiniMax-M2.5",
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "glm-5",
    name: "glm-5",
    reasoning: false,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 202_752,
    maxTokens: 16_384,
  },
  {
    id: "glm-4.7",
    name: "glm-4.7",
    reasoning: false,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 202_752,
    maxTokens: 16_384,
  },
  {
    id: "kimi-k2.5",
    name: "kimi-k2.5",
    reasoning: false,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 32_768,
  },
];

export function isQwenCodingPlanBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === "coding.dashscope.aliyuncs.com" ||
      hostname === "coding-intl.dashscope.aliyuncs.com"
    );
  } catch {
    return false;
  }
}

export function isQwen36PlusSupportedBaseUrl(baseUrl: string | undefined): boolean {
  return !isQwenCodingPlanBaseUrl(baseUrl);
}

export function buildQwenModelCatalogForBaseUrl(
  baseUrl: string | undefined,
): ReadonlyArray<ModelDefinitionConfig> {
  return isQwen36PlusSupportedBaseUrl(baseUrl)
    ? QWEN_MODEL_CATALOG
    : QWEN_MODEL_CATALOG.filter((model) => model.id !== QWEN_36_PLUS_MODEL_ID);
}

export function isNativeQwenBaseUrl(baseUrl: string | undefined): boolean {
  return supportsNativeStreamingUsageCompat({
    providerId: "qwen",
    baseUrl,
  });
}

export function applyQwenNativeStreamingUsageCompat(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  return applyProviderNativeStreamingUsageCompat({
    providerId: "qwen",
    providerConfig: provider,
  });
}

export function buildQwenModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = QWEN_MODEL_CATALOG.find((model) => model.id === params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input:
      (params.input as ("text" | "image")[]) ?? (catalog?.input ? [...catalog.input] : ["text"]),
    cost: params.cost ?? catalog?.cost ?? QWEN_DEFAULT_COST,
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 262_144,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 65_536,
  };
}

export function buildQwenDefaultModelDefinition(): ModelDefinitionConfig {
  return buildQwenModelDefinition({ id: QWEN_DEFAULT_MODEL_ID });
}

// Backward-compatible aliases while `modelstudio` references are still in the wild.
export const MODELSTUDIO_BASE_URL = QWEN_BASE_URL;
export const MODELSTUDIO_GLOBAL_BASE_URL = QWEN_GLOBAL_BASE_URL;
export const MODELSTUDIO_CN_BASE_URL = QWEN_CN_BASE_URL;
export const MODELSTUDIO_STANDARD_CN_BASE_URL = QWEN_STANDARD_CN_BASE_URL;
export const MODELSTUDIO_STANDARD_GLOBAL_BASE_URL = QWEN_STANDARD_GLOBAL_BASE_URL;
export const MODELSTUDIO_DEFAULT_MODEL_ID = QWEN_DEFAULT_MODEL_ID;
export const MODELSTUDIO_DEFAULT_COST = QWEN_DEFAULT_COST;
export const MODELSTUDIO_DEFAULT_MODEL_REF = `modelstudio/${QWEN_DEFAULT_MODEL_ID}`;
export const MODELSTUDIO_MODEL_CATALOG = QWEN_MODEL_CATALOG;
export const isNativeModelStudioBaseUrl = isNativeQwenBaseUrl;
export const applyModelStudioNativeStreamingUsageCompat = applyQwenNativeStreamingUsageCompat;
export const buildModelStudioModelDefinition = buildQwenModelDefinition;
export const buildModelStudioDefaultModelDefinition = buildQwenDefaultModelDefinition;
