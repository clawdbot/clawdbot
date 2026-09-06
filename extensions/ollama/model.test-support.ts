import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";

export function createModel(
  id: string,
  name: string,
  {
    reasoning = false,
    contextWindow = 128_000,
    maxTokens = 8_192,
  }: Partial<Pick<ModelDefinitionConfig, "reasoning" | "contextWindow" | "maxTokens">> = {},
) {
  return {
    id,
    name,
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  } satisfies ModelDefinitionConfig;
}
