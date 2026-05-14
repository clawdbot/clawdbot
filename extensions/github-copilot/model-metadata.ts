import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

type CopilotRuntimeApi = "anthropic-messages" | "openai-completions" | "openai-responses";

const COPILOT_CHAT_COMPLETIONS_COMPAT: ModelDefinitionConfig["compat"] = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens",
};

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

function isCopilotGeminiModelId(modelId: string): boolean {
  return /(?:^|[-_.])gemini(?:$|[-_.])/.test(modelId);
}

export function resolveCopilotTransportApi(modelId: string): CopilotRuntimeApi {
  const normalized = normalizeOptionalLowercaseString(modelId) ?? "";
  if (normalized.includes("claude")) {
    return "anthropic-messages";
  }
  if (isCopilotGeminiModelId(normalized)) {
    return "openai-completions";
  }
  return "openai-responses";
}

export function resolveCopilotModelCompat(
  modelId: string,
): ModelDefinitionConfig["compat"] | undefined {
  const normalized = normalizeOptionalLowercaseString(modelId) ?? "";
  return isCopilotGeminiModelId(normalized) ? { ...COPILOT_CHAT_COMPLETIONS_COMPAT } : undefined;
}

export function resolveStaticCopilotModelOverride(
  modelId: string,
): Partial<ModelDefinitionConfig> | undefined {
  return STATIC_MODEL_OVERRIDES.get(normalizeOptionalLowercaseString(modelId) ?? "");
}
