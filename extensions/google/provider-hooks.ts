// Google provider module implements model/runtime integration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/core";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { resolveGoogleThinkingProfile } from "./provider-policy.js";
import { createGoogleThinkingStreamWrapper } from "./thinking-api.js";

export const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "google-gemini",
  }),
  ...buildProviderToolCompatFamilyHooks("gemini"),
  resolveThinkingProfile: (context: ProviderDefaultThinkingPolicyContext) =>
    resolveGoogleThinkingProfile(context) satisfies ProviderThinkingProfile | undefined,
  wrapStreamFn: createGoogleThinkingStreamWrapper,
};
