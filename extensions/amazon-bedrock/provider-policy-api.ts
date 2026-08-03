/**
 * Provider-policy API for Amazon Bedrock. Core asks this plugin for thinking
 * profiles without importing provider registration or streaming code.
 */
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveBedrockClaudeThinkingProfile } from "./thinking-policy.js";

/** Resolve the Bedrock thinking profile for a provider/model pair. */
export function resolveThinkingProfile(params: {
  provider: string;
  modelId: string;
  params?: Record<string, unknown>;
}) {
  if (normalizeProviderId(params.provider) !== "amazon-bedrock") {
    return null;
  }
  return resolveBedrockClaudeThinkingProfile(params.modelId, params.params);
}
