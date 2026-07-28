/**
 * Apiário model catalog metadata.
 */
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

/** Default Apiário API base URL. */
export const APIARIO_BASE_URL = "https://api.apiario.dev/v1";

/** Static Apiário model catalog. */
export const APIARIO_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "apiario/default",
    name: "Apiário Default",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
];

/** Build one OpenAI-compatible Apiário model definition. */
export function buildApiarioModelDefinition(
  model: (typeof APIARIO_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: model.compat } : {}),
  };
}
