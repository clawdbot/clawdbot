import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Distinct literal provider namespaces shared by model selection boundary tests. */
export function createNamespacedModelConfig(
  models: Array<Pick<ModelDefinitionConfig, "id"> & Partial<ModelDefinitionConfig>> = [
    { id: "model" },
    { id: "custom/model" },
  ],
): OpenClawConfig {
  return {
    models: {
      providers: {
        custom: {
          api: "openai-completions",
          baseUrl: "https://custom.example/v1",
          models: models.map((model) => ({
            name: model.id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 1_024,
            ...model,
          })),
        },
      },
    },
    agents: {
      defaults: {
        models: {
          "custom/model": { alias: "plain" },
          "custom/custom/model": { alias: "nested" },
        },
      },
    },
  };
}
