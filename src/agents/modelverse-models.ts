import type { ModelDefinitionConfig } from "../config/types.js";

export const MODELVERSE_BASE_URL = "https://api.modelverse.cn/v1";
export const MODELVERSE_DEFAULT_MODEL_ID = "gpt-5.2";
export const MODELVERSE_DEFAULT_MODEL_REF = `modelverse/${MODELVERSE_DEFAULT_MODEL_ID}`;

export const MODELVERSE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Modelverse is an OpenAI-compatible proxy; metadata is best-effort and can be overridden via
// models.providers.modelverse.models in config.
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;

export const MODELVERSE_MODEL_CATALOG = [
  {
    id: MODELVERSE_DEFAULT_MODEL_ID,
    name: "GPT-5.2",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "claude-opus-4-5-20251101",
    name: "Claude Opus 4.5 (20251101)",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5 (20250929)",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "deepseek-ai/DeepSeek-V3-0324",
    name: "DeepSeek V3 0324",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "zai-org/glm-4.7",
    name: "GLM-4.7",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
] as const;

export type ModelverseCatalogEntry = (typeof MODELVERSE_MODEL_CATALOG)[number];

export function buildModelverseModelDefinition(
  entry: ModelverseCatalogEntry,
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: MODELVERSE_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
