import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";

const RESPONSES_FAMILY_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

/**
 * Returns the provider-owned replay policy for OpenAI-family transports.
 */
export function buildOpenAIReplayPolicy(ctx: ProviderReplayPolicyContext): ProviderReplayPolicy {
  const isResponsesFamily = RESPONSES_FAMILY_APIS.has(ctx.modelApi ?? "");
  return {
    sanitizeMode: "images-only",
    applyAssistantFirstOrderingFix: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
    ...(isResponsesFamily ? { allowSyntheticToolResults: true } : {}),
    ...(ctx.modelApi === "openai-completions"
      ? {
          sanitizeToolCallIds: true,
          toolCallIdMode: "strict" as const,
        }
      : {
          sanitizeToolCallIds: false,
        }),
  };
}
