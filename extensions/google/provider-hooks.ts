import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/core";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createGoogleThinkingStreamWrapper, isGoogleGemini3ProModel } from "./thinking-api.js";

export const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "google-gemini",
  }),
  resolveThinkingProfile: ({ modelId }: ProviderDefaultThinkingPolicyContext) =>
    ({
      levels: isGoogleGemini3ProModel(modelId)
        ? [{ id: "off" }, { id: "low" }, { id: "high" }]
        : [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    }) satisfies ProviderThinkingProfile,
  wrapStreamFn: createGoogleThinkingStreamWrapper,
};
