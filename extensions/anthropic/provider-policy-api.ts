import { resolveClaudeThinkingProfile } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfigForProvider,
} from "./config-defaults.js";

export function normalizeConfig(params: { provider: string; providerConfig: ModelProviderConfig }) {
  return normalizeAnthropicProviderConfigForProvider(params);
}

export function applyConfigDefaults(params: Parameters<typeof applyAnthropicConfigDefaults>[0]) {
  return applyAnthropicConfigDefaults(params);
}

export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  switch (params.provider.trim().toLowerCase()) {
    case "anthropic":
    case "claude-cli":
      return resolveClaudeThinkingProfile(params.modelId);
    default:
      return null;
  }
}
