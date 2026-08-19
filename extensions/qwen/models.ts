// Qwen plugin module implements models behavior.
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
export const QWEN_TOKEN_PLAN_PROVIDER_ID = "qwen-token-plan";
export const QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID = "bailian-token-plan";
export const QWEN_TOKEN_PLAN_GLOBAL_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
export const QWEN_TOKEN_PLAN_CN_BASE_URL =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

export const QWEN_DEFAULT_MODEL_ID = "qwen3.5-plus";
export const QWEN_36_FLASH_MODEL_ID = "qwen3.6-flash";
export const QWEN_36_PLUS_MODEL_ID = "qwen3.6-plus";
export const QWEN_37_MAX_MODEL_ID = "qwen3.7-max";
export const QWEN_37_PLUS_MODEL_ID = "qwen3.7-plus";
export const QWEN_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const QWEN_DEFAULT_MODEL_REF = `qwen/${QWEN_DEFAULT_MODEL_ID}`;
export const QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID = QWEN_37_PLUS_MODEL_ID;
export const QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF = `${QWEN_TOKEN_PLAN_PROVIDER_ID}/${QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID}`;

export function isQwenTokenPlanThinkingOnlyModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized === "minimax-m2.5" || normalized.startsWith("kimi-k2.7-code");
}

export function isQwenTokenPlanDeepSeekV4ModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("deepseek-v4");
}

export function isQwenTokenPlanKimiModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("kimi-");
}

export function isQwenTokenPlanGlmModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("glm-");
}

export function supportsQwenTokenPlanGlmMaxThinking(modelId: string): boolean {
  return modelId.trim().toLowerCase() === "glm-5.2";
}

const QWEN_TOKEN_PLAN_BASE_URLS = {
  global: QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  cn: QWEN_TOKEN_PLAN_CN_BASE_URL,
} as const;

export type QwenTokenPlanRegion = keyof typeof QWEN_TOKEN_PLAN_BASE_URLS;

export function resolveQwenTokenPlanBaseUrl(region: QwenTokenPlanRegion): string {
  return QWEN_TOKEN_PLAN_BASE_URLS[region];
}

type QwenCatalogModelRow = readonly [
  id: string,
  reasoning: boolean,
  input: ModelDefinitionConfig["input"],
  contextWindow: number,
  maxTokens: number,
];

function buildQwenCatalogModels(rows: readonly QwenCatalogModelRow[]): ModelDefinitionConfig[] {
  return rows.map(([id, reasoning, input, contextWindow, maxTokens]) => ({
    id,
    name: id,
    reasoning,
    input,
    cost: QWEN_DEFAULT_COST,
    contextWindow,
    maxTokens,
  }));
}

// Token Plan is credit-based, so per-token prices do not map to its billing model.
// This curated picker catalog keeps current recommendations plus one selectable compatibility row.
export const QWEN_TOKEN_PLAN_MODEL_CATALOG: ReadonlyArray<ModelDefinitionConfig> =
  buildQwenCatalogModels([
    [QWEN_37_PLUS_MODEL_ID, true, ["text", "image"], 1_000_000, 65_536],
    [QWEN_36_PLUS_MODEL_ID, true, ["text", "image"], 1_000_000, 65_536],
    ["qwen3-coder-next", true, ["text"], 262_144, 65_536],
    ["kimi-k2.5", true, ["text", "image"], 262_144, 98_304],
    ["glm-5", true, ["text"], 202_752, 16_384],
    ["MiniMax-M2.5", true, ["text"], 196_608, 32_768],
  ]);

export const QWEN_MODEL_CATALOG: ReadonlyArray<ModelDefinitionConfig> = buildQwenCatalogModels([
  [QWEN_DEFAULT_MODEL_ID, false, ["text", "image"], 1_000_000, 65_536],
  [QWEN_36_FLASH_MODEL_ID, true, ["text", "image"], 1_000_000, 65_536],
  [QWEN_36_PLUS_MODEL_ID, true, ["text", "image"], 1_000_000, 65_536],
  [QWEN_37_MAX_MODEL_ID, true, ["text"], 1_000_000, 65_536],
  [QWEN_37_PLUS_MODEL_ID, true, ["text", "image"], 1_000_000, 65_536],
  ["qwen3-max-2026-01-23", false, ["text"], 262_144, 65_536],
  ["qwen3-coder-next", false, ["text"], 262_144, 65_536],
  ["qwen3-coder-plus", false, ["text"], 1_000_000, 65_536],
  ["MiniMax-M2.5", true, ["text"], 1_000_000, 65_536],
  ["glm-5", false, ["text"], 202_752, 16_384],
  ["glm-4.7", false, ["text"], 202_752, 16_384],
  ["kimi-k2.5", false, ["text", "image"], 262_144, 32_768],
]);

export function isQwenCodingPlanBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
    return (
      hostname === "coding.dashscope.aliyuncs.com" ||
      hostname === "coding-intl.dashscope.aliyuncs.com"
    );
  } catch {
    return false;
  }
}

export function isQwen36PlusSupportedBaseUrl(_baseUrl: string | undefined): boolean {
  return true;
}

const QWEN_STANDARD_ONLY_MODEL_IDS = new Set<string>([
  QWEN_36_FLASH_MODEL_ID,
  QWEN_37_MAX_MODEL_ID,
]);

export function isQwenStandardOnlyModelId(modelId: string): boolean {
  return QWEN_STANDARD_ONLY_MODEL_IDS.has(modelId);
}

export function buildQwenModelCatalogForBaseUrl(
  baseUrl: string | undefined,
): ReadonlyArray<ModelDefinitionConfig> {
  return isQwenCodingPlanBaseUrl(baseUrl)
    ? QWEN_MODEL_CATALOG.filter((model) => !isQwenStandardOnlyModelId(model.id))
    : QWEN_MODEL_CATALOG;
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

/** @deprecated Use QWEN_BASE_URL. */
export const MODELSTUDIO_BASE_URL = QWEN_BASE_URL;
/** @deprecated Use QWEN_GLOBAL_BASE_URL. */
export const MODELSTUDIO_GLOBAL_BASE_URL = QWEN_GLOBAL_BASE_URL;
/** @deprecated Use QWEN_CN_BASE_URL. */
export const MODELSTUDIO_CN_BASE_URL = QWEN_CN_BASE_URL;
/** @deprecated Use QWEN_STANDARD_CN_BASE_URL. */
export const MODELSTUDIO_STANDARD_CN_BASE_URL = QWEN_STANDARD_CN_BASE_URL;
/** @deprecated Use QWEN_STANDARD_GLOBAL_BASE_URL. */
export const MODELSTUDIO_STANDARD_GLOBAL_BASE_URL = QWEN_STANDARD_GLOBAL_BASE_URL;
/** @deprecated Use QWEN_DEFAULT_MODEL_ID. */
export const MODELSTUDIO_DEFAULT_MODEL_ID = QWEN_DEFAULT_MODEL_ID;
/** @deprecated Use QWEN_DEFAULT_COST. */
export const MODELSTUDIO_DEFAULT_COST = QWEN_DEFAULT_COST;
/** @deprecated Use qwen/${QWEN_DEFAULT_MODEL_ID}. */
export const MODELSTUDIO_DEFAULT_MODEL_REF = `modelstudio/${QWEN_DEFAULT_MODEL_ID}`;
/** @deprecated Use QWEN_MODEL_CATALOG. */
export const MODELSTUDIO_MODEL_CATALOG = QWEN_MODEL_CATALOG;
export const isNativeModelStudioBaseUrl = isNativeQwenBaseUrl;
export const applyModelStudioNativeStreamingUsageCompat = applyQwenNativeStreamingUsageCompat;
export const buildModelStudioModelDefinition = buildQwenModelDefinition;
export const buildModelStudioDefaultModelDefinition = buildQwenDefaultModelDefinition;
