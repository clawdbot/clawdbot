import type { ModelDefinitionConfig } from "../config/types.js";

export const NILLION_BASE_URL = "https://nilai-f910.nillion.network/v1";
export const NILLION_DEFAULT_MODEL_ID = "openai/gpt-oss-20b";
export const NILLION_DEFAULT_MODEL_REF = `nillion/${NILLION_DEFAULT_MODEL_ID}`;

// Nillion uses credit-based pricing. Set to 0 as costs vary.
export const NILLION_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const NILLION_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
} as const;

/**
 * Catalog of Nillion nilAI models.
 *
 * Nillion provides privacy-preserving AI inference using secure multi-party
 * computation (MPC) and other cryptographic techniques. The nilAI platform
 * uses blind computation to keep your data private during inference.
 *
 * Model ID mapping:
 * - User-facing: nillion/openai/gpt-oss-20b
 * - Display name: nilAI Private 20B
 * - API model ID: openai/gpt-oss-20b
 */
export const NILLION_MODEL_CATALOG = [
  {
    id: "openai/gpt-oss-20b",
    name: "nilAI Private 20B",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
] as const;

export type NillionCatalogEntry = (typeof NILLION_MODEL_CATALOG)[number];

/**
 * Build a ModelDefinitionConfig from a Nillion catalog entry.
 */
export function buildNillionModelDefinition(entry: NillionCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: NILLION_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: NILLION_COMPAT,
  };
}
