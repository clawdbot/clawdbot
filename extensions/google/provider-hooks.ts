import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { GOOGLE_THINKING_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";

export const GOOGLE_GEMINI_PROVIDER_HOOKS = {
  ...buildProviderReplayFamilyHooks({
    family: "google-gemini",
  }),
  ...GOOGLE_THINKING_STREAM_HOOKS,
};
