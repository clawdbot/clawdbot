import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

const STATIC_MODEL_OVERRIDES = new Map<string, Partial<ModelDefinitionConfig>>([
  [
    "gpt-5.5",
    {
      name: "GPT-5.5",
      reasoning: true,
      contextWindow: 400_000,
      maxTokens: 128_000,
    },
  ],
]);

export function resolveCopilotTransportApi(
  modelId: string,
): "anthropic-messages" | "openai-responses" {
  return (normalizeOptionalLowercaseString(modelId) ?? "").includes("claude")
    ? "anthropic-messages"
    : "openai-responses";
}

export function resolveStaticCopilotModelOverride(
  modelId: string,
): Partial<ModelDefinitionConfig> | undefined {
  return STATIC_MODEL_OVERRIDES.get(normalizeOptionalLowercaseString(modelId) ?? "");
}
