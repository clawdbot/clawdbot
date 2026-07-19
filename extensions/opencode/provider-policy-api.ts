// Opencode API module exposes the plugin public contract.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveClaudeThinkingProfile } from "openclaw/plugin-sdk/provider-model-shared";

const GPT_56_THINKING_PROFILE = {
  levels: [
    { id: "off" },
    { id: "low" },
    { id: "medium" },
    { id: "high" },
    { id: "xhigh" },
    { id: "max" },
  ],
  defaultLevel: "medium",
} as const satisfies ProviderThinkingProfile;

function isGpt56Model(modelId: string): boolean {
  return /^gpt-5\.6(?:-|$)/u.test(modelId.trim().toLowerCase());
}

export function resolveThinkingProfile(params: ProviderDefaultThinkingPolicyContext) {
  if (isGpt56Model(params.modelId)) {
    return GPT_56_THINKING_PROFILE;
  }
  return resolveClaudeThinkingProfile(params.modelId);
}
