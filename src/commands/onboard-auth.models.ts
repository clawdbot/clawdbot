import type { ModelDefinitionConfig } from "../config/types.js";

export const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
export const MINIMAX_HOSTED_MODEL_ID = "MiniMax-M2.1";
export const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;
export const DEFAULT_MINIMAX_CONTEXT_WINDOW = 200000;
export const DEFAULT_MINIMAX_MAX_TOKENS = 8192;

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2-0905-preview";
export const MOONSHOT_DEFAULT_MODEL_REF = `moonshot/${MOONSHOT_DEFAULT_MODEL_ID}`;
export const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
export const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;

export const CHUTES_BASE_URL = "https://llm.chutes.ai/v1";
export const CHUTES_DEFAULT_MODEL_ID = "zai-org/GLM-4.7-Flash";
export const CHUTES_DEFAULT_MODEL_REF = `chutes/${CHUTES_DEFAULT_MODEL_ID}`;
export const CHUTES_DEFAULT_CONTEXT_WINDOW = 128000;
export const CHUTES_DEFAULT_MAX_TOKENS = 4096;

export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CODE_MODEL_ID = "kimi-for-coding";
export const KIMI_CODE_MODEL_REF = `kimi-code/${KIMI_CODE_MODEL_ID}`;
export const KIMI_CODE_CONTEXT_WINDOW = 262144;
export const KIMI_CODE_MAX_TOKENS = 32768;
export const KIMI_CODE_HEADERS = { "User-Agent": "KimiCLI/0.77" } as const;
export const KIMI_CODE_COMPAT = { supportsDeveloperRole: false } as const;

// Pricing: MiniMax doesn't publish public rates. Override in models.json for accurate costs.
export const MINIMAX_API_COST = {
  input: 15,
  output: 60,
  cacheRead: 2,
  cacheWrite: 10,
};
export const MINIMAX_HOSTED_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const MINIMAX_LM_STUDIO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const CHUTES_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const KIMI_CODE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const MINIMAX_MODEL_CATALOG = {
  "MiniMax-M2.1": { name: "MiniMax M2.1", reasoning: false },
  "MiniMax-M2.1-lightning": {
    name: "MiniMax M2.1 Lightning",
    reasoning: false,
  },
} as const;

type MinimaxCatalogId = keyof typeof MINIMAX_MODEL_CATALOG;

export function buildMinimaxModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  cost: ModelDefinitionConfig["cost"];
  contextWindow: number;
  maxTokens: number;
}): ModelDefinitionConfig {
  const catalog = MINIMAX_MODEL_CATALOG[params.id as MinimaxCatalogId];
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? `MiniMax ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: ["text"],
    cost: params.cost,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  };
}

export function buildMinimaxApiModelDefinition(modelId: string): ModelDefinitionConfig {
  return buildMinimaxModelDefinition({
    id: modelId,
    cost: MINIMAX_API_COST,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
}

export function buildMoonshotModelDefinition(): ModelDefinitionConfig {
  return {
    id: MOONSHOT_DEFAULT_MODEL_ID,
    name: "Kimi K2 0905 Preview",
    reasoning: false,
    input: ["text"],
    cost: MOONSHOT_DEFAULT_COST,
    contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
  };
}

export function buildChutesModelDefinition(
  modelId: string = CHUTES_DEFAULT_MODEL_ID,
): ModelDefinitionConfig {
  if (modelId === "Qwen/Qwen3-235B-A22B-Instruct-2507-TEE") {
    return {
      id: modelId,
      name: "Qwen 3 235B (Tools)",
      reasoning: false,
      input: ["text"],
      cost: CHUTES_DEFAULT_COST,
      contextWindow: 262144,
      maxTokens: 4096,
    };
  }
  if (modelId === "deepseek-ai/DeepSeek-V3.2-TEE") {
    return {
      id: modelId,
      name: "DeepSeek V3.2 (Tools)",
      reasoning: false,
      input: ["text"],
      cost: CHUTES_DEFAULT_COST,
      contextWindow: 202752,
      maxTokens: 4096,
    };
  }
  if (modelId === "chutesai/Mistral-Small-3.1-24B-Instruct-2503") {
    return {
      id: modelId,
      name: "Mistral Small 3.1 (Tools)",
      reasoning: false,
      input: ["text"],
      cost: CHUTES_DEFAULT_COST,
      contextWindow: 131072,
      maxTokens: 4096,
    };
  }
  if (modelId === "NousResearch/Hermes-4-14B") {
    return {
      id: modelId,
      name: "Hermes 4 14B (Tools)",
      reasoning: false,
      input: ["text"],
      cost: CHUTES_DEFAULT_COST,
      contextWindow: 40960,
      maxTokens: 4096,
    };
  }
  return {
    id: CHUTES_DEFAULT_MODEL_ID,
    name: "GLM 4.7 Flash",
    reasoning: false,
    input: ["text"],
    cost: CHUTES_DEFAULT_COST,
    contextWindow: CHUTES_DEFAULT_CONTEXT_WINDOW,
    maxTokens: CHUTES_DEFAULT_MAX_TOKENS,
  };
}

export function buildKimiCodeModelDefinition(): ModelDefinitionConfig {
  return {
    id: KIMI_CODE_MODEL_ID,
    name: "Kimi For Coding",
    reasoning: true,
    input: ["text"],
    cost: KIMI_CODE_DEFAULT_COST,
    contextWindow: KIMI_CODE_CONTEXT_WINDOW,
    maxTokens: KIMI_CODE_MAX_TOKENS,
    headers: KIMI_CODE_HEADERS,
    compat: KIMI_CODE_COMPAT,
  };
}
