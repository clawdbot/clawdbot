import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  resolveOpenAICodexThinkingProfile,
  resolveOpenAIThinkingProfile,
} from "./thinking-policy.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return params.providerConfig;
}

export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  switch (params.provider.trim().toLowerCase()) {
    case "openai":
      return resolveOpenAIThinkingProfile(params.modelId);
    case "openai-codex":
      return resolveOpenAICodexThinkingProfile(params.modelId);
    default:
      return null;
  }
}
