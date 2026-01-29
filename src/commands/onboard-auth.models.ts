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

// Kilo Gateway model definitions
export const KILOCODE_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.5";
export const KILOCODE_DEFAULT_CONTEXT_WINDOW = 200000;
export const KILOCODE_DEFAULT_MAX_TOKENS = 8192;
export const KILOCODE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildKilocodeModelDefinition(): ModelDefinitionConfig {
  return {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: "Claude Opus 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: KILOCODE_DEFAULT_COST,
    contextWindow: KILOCODE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: KILOCODE_DEFAULT_MAX_TOKENS,
  };
}
