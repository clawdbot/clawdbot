import type { ModelDefinitionConfig } from "../config/types.js";

export const POLLINATIONS_BASE_URL = "https://gen.pollinations.ai/v1";
export const POLLINATIONS_DEFAULT_MODEL_ID = "openai";
export const POLLINATIONS_DEFAULT_MODEL_REF = `pollinations/${POLLINATIONS_DEFAULT_MODEL_ID}`;
export const POLLINATIONS_MINIMAX_MODEL_ID = "minimax";
export const POLLINATIONS_MINIMAX_MODEL_REF = `pollinations/${POLLINATIONS_MINIMAX_MODEL_ID}`;

export const POLLINATIONS_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const POLLINATIONS_MODEL_CATALOG = [
  {
    id: POLLINATIONS_DEFAULT_MODEL_ID,
    name: "Pollinations OpenAI",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: POLLINATIONS_MINIMAX_MODEL_ID,
    name: "Pollinations MiniMax",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "openai-fast",
    name: "Pollinations OpenAI Fast",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "openai-large",
    name: "Pollinations OpenAI Large",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "qwen-coder",
    name: "Pollinations Qwen Coder",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "mistral",
    name: "Pollinations Mistral",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
] as const;

export type PollinationsCatalogEntry = (typeof POLLINATIONS_MODEL_CATALOG)[number];

export function buildPollinationsModelDefinition(
  entry: PollinationsCatalogEntry,
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input] as ("text" | "image")[],
    cost: POLLINATIONS_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
