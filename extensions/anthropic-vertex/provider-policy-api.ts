import { resolveClaudeThinkingProfile } from "openclaw/plugin-sdk/provider-model-shared";

export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  if (params.provider.trim().toLowerCase() !== "anthropic-vertex") {
    return null;
  }
  return resolveClaudeThinkingProfile(params.modelId);
}
