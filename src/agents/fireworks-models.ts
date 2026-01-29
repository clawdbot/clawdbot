import type { ModelDefinitionConfig } from "../config/types.js";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const FIREWORKS_DEFAULT_MODEL_ID = "accounts/fireworks/models/deepseek-v3p2";
export const FIREWORKS_DEFAULT_MODEL_REF = `fireworks/${FIREWORKS_DEFAULT_MODEL_ID}`;

// Fireworks uses pay-per-token pricing; rates vary by model.
// Set to 0 as a default; override in models.json for accurate costs.
export const FIREWORKS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Static catalog of Fireworks AI serverless models.
 *
 * Only includes LLM models (no image generation), non-deprecated models,
 * and models that support serverless inference.
 *
 * Model IDs use the full format: accounts/fireworks/models/<model>
 */
export const FIREWORKS_MODEL_CATALOG = [
  // DeepSeek models
  {
    id: "accounts/fireworks/models/deepseek-r1-0528",
    name: "Deepseek R1 05/28",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 163840,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/deepseek-v3-0324",
    name: "Deepseek V3 03-24",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 163840,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/deepseek-v3p1",
    name: "DeepSeek V3.1",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 163840,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/deepseek-v3p1-terminus",
    name: "DeepSeek V3.1 Terminus",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 163840,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/deepseek-v3p2",
    name: "Deepseek v3.2",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 163840,
    maxTokens: 8192,
  },

  // GLM models - both support "advanced thinking controls"
  {
    id: "accounts/fireworks/models/glm-4p6",
    name: "GLM-4.6",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 202752,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/glm-4p7",
    name: "GLM-4.7",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 202752,
    maxTokens: 8192,
  },

  // OpenAI gpt-oss models - designed for "powerful reasoning, agentic tasks"
  {
    id: "accounts/fireworks/models/gpt-oss-120b",
    name: "OpenAI gpt-oss-120b",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/gpt-oss-20b",
    name: "OpenAI gpt-oss-20b",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
  },

  // Kimi models
  {
    id: "accounts/fireworks/models/kimi-k2-instruct-0905",
    name: "Kimi K2 Instruct 0905",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/kimi-k2p5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: true,
    input: ["text"] as const,
    // API returns 0 but description says 256k
    contextWindow: 256000,
    maxTokens: 8192,
  },

  // Llama models
  {
    id: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    name: "Llama 3.3 70B Instruct",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
  },

  // MiniMax models - compact MoE for coding and agentic tasks
  {
    id: "accounts/fireworks/models/minimax-m2",
    name: "MiniMax-M2",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 196608,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/minimax-m2p1",
    name: "MiniMax-M2.1",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 204800,
    maxTokens: 8192,
  },

  // Qwen text models
  {
    id: "accounts/fireworks/models/qwen3-235b-a22b",
    name: "Qwen3 235B A22B",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/qwen3-235b-a22b-instruct-2507",
    name: "Qwen3 235B A22B Instruct 2507",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/qwen3-235b-a22b-thinking-2507",
    name: "Qwen3 235B A22B Thinking 2507",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/qwen3-8b",
    name: "Qwen3 8B",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 40960,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
    name: "Qwen3 Coder 480B A35B Instruct",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },

  // Qwen vision models
  {
    id: "accounts/fireworks/models/qwen2p5-vl-32b-instruct",
    name: "Qwen2.5-VL 32B Instruct",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/qwen3-vl-235b-a22b-instruct",
    name: "Qwen3 VL 235B A22B Instruct",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/qwen3-vl-235b-a22b-thinking",
    name: "Qwen3 VL 235B A22B Thinking",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct",
    name: "Qwen3 VL 30B A3B Instruct",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },
  {
    id: "accounts/fireworks/models/qwen3-vl-30b-a3b-thinking",
    name: "Qwen3 VL 30B A3B Thinking",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 262144,
    maxTokens: 8192,
  },
] as const;

export type FireworksCatalogEntry = (typeof FIREWORKS_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from a Fireworks catalog entry.
 */
export function buildFireworksModelDefinition(entry: FireworksCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: FIREWORKS_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

/**
 * Returns Fireworks models from the static catalog.
 */
export function discoverFireworksModels(): ModelDefinitionConfig[] {
  return FIREWORKS_MODEL_CATALOG.map(buildFireworksModelDefinition);
}
