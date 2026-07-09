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
export const QWEN_OAUTH_PROVIDER_ID = "qwen-oauth";
export const QWEN_OAUTH_BASE_URL = "https://portal.qwen.ai/v1";
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
export const QWEN_OAUTH_DEFAULT_MODEL_REF = `qwen-oauth/${QWEN_DEFAULT_MODEL_ID}`;
export const QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID = QWEN_37_PLUS_MODEL_ID;
export const QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF = `${QWEN_TOKEN_PLAN_PROVIDER_ID}/${QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID}`;

const QWEN_TOKEN_PLAN_THINKING_ONLY_MODEL_IDS = new Set(["kimi-k2.7-code", "minimax-m2.5"]);
const QWEN_TOKEN_PLAN_DEEPSEEK_V4_MODEL_IDS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const QWEN_TOKEN_PLAN_KIMI_MODEL_IDS = new Set(["kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5"]);
const QWEN_TOKEN_PLAN_GLM_MODEL_IDS = new Set(["glm-5.2", "glm-5.1", "glm-5"]);

export function isQwenTokenPlanThinkingOnlyModelId(modelId: string): boolean {
  return QWEN_TOKEN_PLAN_THINKING_ONLY_MODEL_IDS.has(modelId.trim().toLowerCase());
}

export function isQwenTokenPlanDeepSeekV4ModelId(modelId: string): boolean {
  return QWEN_TOKEN_PLAN_DEEPSEEK_V4_MODEL_IDS.has(modelId.trim().toLowerCase());
}

export function isQwenTokenPlanKimiModelId(modelId: string): boolean {
  return QWEN_TOKEN_PLAN_KIMI_MODEL_IDS.has(modelId.trim().toLowerCase());
}

export function isQwenTokenPlanGlmModelId(modelId: string): boolean {
  return QWEN_TOKEN_PLAN_GLM_MODEL_IDS.has(modelId.trim().toLowerCase());
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

// Token Plan is credit-based, so per-token prices do not map to its billing model.
// This is the exact chat allowlist; image-generation-only models use separate APIs.
export const QWEN_TOKEN_PLAN_MODEL_CATALOG: ReadonlyArray<ModelDefinitionConfig> = [
  {
    id: QWEN_37_MAX_MODEL_ID,
    name: QWEN_37_MAX_MODEL_ID,
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: QWEN_37_PLUS_MODEL_ID,
    name: QWEN_37_PLUS_MODEL_ID,
    reasoning: true,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: QWEN_36_PLUS_MODEL_ID,
    name: QWEN_36_PLUS_MODEL_ID,
    reasoning: true,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: QWEN_36_FLASH_MODEL_ID,
    name: QWEN_36_FLASH_MODEL_ID,
    reasoning: true,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "deepseek-v4-pro",
    name: "deepseek-v4-pro",
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 393_216,
  },
  {
    id: "deepseek-v4-flash",
    name: "deepseek-v4-flash",
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 393_216,
  },
  {
    id: "deepseek-v3.2",
    name: "deepseek-v3.2",
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 131_072,
    maxTokens: 65_536,
  },
  {
    id: "kimi-k2.7-code",
    name: "kimi-k2.7-code",
    reasoning: true,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 98_304,
  },
  {
    id: "kimi-k2.6",
    name: "kimi-k2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 98_304,
  },
  {
    id: "kimi-k2.5",
    name: "kimi-k2.5",
    reasoning: true,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 98_304,
  },
  {
    id: "glm-5.2",
    name: "glm-5.2",
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  {
    id: "glm-5.1",
    name: "glm-5.1",
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 202_752,
    maxTokens: 131_072,
  },
  {
    id: "glm-5",
    name: "glm-5",
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 202_752,
    maxTokens: 16_384,
  },
  {
    id: "MiniMax-M2.5",
    name: "MiniMax-M2.5",
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 196_608,
    maxTokens: 32_768,
  },
];

export function isQwenTokenPlanModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return QWEN_TOKEN_PLAN_MODEL_CATALOG.some((model) => model.id.toLowerCase() === normalized);
}

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
    id: QWEN_36_FLASH_MODEL_ID,
    name: QWEN_36_FLASH_MODEL_ID,
    reasoning: true,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: QWEN_36_PLUS_MODEL_ID,
    name: QWEN_36_PLUS_MODEL_ID,
    reasoning: true,
    input: ["text", "image"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: QWEN_37_MAX_MODEL_ID,
    name: QWEN_37_MAX_MODEL_ID,
    reasoning: true,
    input: ["text"],
    cost: QWEN_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: QWEN_37_PLUS_MODEL_ID,
    name: QWEN_37_PLUS_MODEL_ID,
    reasoning: true,
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

const QWEN_OAUTH_UNSUPPORTED_MODEL_IDS = new Set<string>([
  QWEN_36_FLASH_MODEL_ID,
  QWEN_37_MAX_MODEL_ID,
  QWEN_37_PLUS_MODEL_ID,
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

export function buildQwenOAuthModelCatalog(): ReadonlyArray<ModelDefinitionConfig> {
  return QWEN_MODEL_CATALOG.filter((model) => !QWEN_OAUTH_UNSUPPORTED_MODEL_IDS.has(model.id)).map(
    (model) => Object.assign({}, model, { maxTokens: 65_536 }),
  );
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
