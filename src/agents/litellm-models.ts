import type { ModelDefinitionConfig } from "../config/types.js";

// LiteLLM is a proxy that supports many models, so the base URL and model
// are user-configurable. We provide sensible defaults for onboarding.
export const LITELLM_DEFAULT_BASE_URL = "http://localhost:4000";
export const LITELLM_DEFAULT_MODEL_ID = "gpt-4";
export const LITELLM_DEFAULT_MODEL_REF = `litellm/${LITELLM_DEFAULT_MODEL_ID}`;
export const LITELLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export type LitellmModelEntry = {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: readonly ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
};

export function buildLitellmModelDefinition(entry: LitellmModelEntry): ModelDefinitionConfig {
  // Detect Claude models and use Anthropic Messages API for proper cache control support
  const isClaude = entry.id.toLowerCase().startsWith("claude-");

  return {
    id: entry.id,
    name: entry.name,
    // Claude models through LiteLLM should use anthropic-messages API for cache control
    ...(isClaude ? { api: "anthropic-messages" as const } : {}),
    reasoning: entry.reasoning ?? false,
    input: entry.input ? [...entry.input] : ["text"],
    cost: LITELLM_DEFAULT_COST,
    contextWindow: entry.contextWindow ?? 128000,
    maxTokens: entry.maxTokens ?? 8192,
    // LiteLLM proxies to various providers that may not support the OpenAI Responses API
    // `store` parameter. Disable it by default to avoid "Extra inputs are not permitted" errors.
    compat: { supportsStore: false },
  };
}

/**
 * Creates a model reference for a LiteLLM model.
 * The model ID can be any model supported by the LiteLLM proxy.
 */
export function litellmModelRef(modelId: string): string {
  return `litellm/${modelId}`;
}
