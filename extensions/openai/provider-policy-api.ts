import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return params.providerConfig;
}

export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  switch (params.provider.trim().toLowerCase()) {
    case "openai":
      return resolveUnifiedOpenAIThinkingProfile(params.modelId);
    default:
      return null;
  }
}
