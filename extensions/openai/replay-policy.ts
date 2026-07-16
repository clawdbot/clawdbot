import type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";

/**
 * Returns the provider-owned replay policy for OpenAI-family transports.
 */
export function buildOpenAIReplayPolicy(ctx: ProviderReplayPolicyContext): ProviderReplayPolicy {
  return {
    sanitizeMode: "images-only",
    applyAssistantFirstOrderingFix: false,
    validateGeminiTurns: false,
    validateAnthropicTurns: false,
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
