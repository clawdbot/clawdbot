import {
  buildProviderReplayFamilyHooks,
  defineSelfHostedOpenAICompatibleProvider,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  SGLANG_DEFAULT_API_KEY_ENV_VAR,
  SGLANG_DEFAULT_BASE_URL,
  SGLANG_MODEL_PLACEHOLDER,
  SGLANG_PROVIDER_LABEL,
} from "./api.js";

export default defineSelfHostedOpenAICompatibleProvider({
  id: "sglang",
  label: SGLANG_PROVIDER_LABEL,
  hint: "Fast self-hosted OpenAI-compatible server",
  groupHint: "Fast self-hosted server",
  defaultBaseUrl: SGLANG_DEFAULT_BASE_URL,
  apiKeyEnvVar: SGLANG_DEFAULT_API_KEY_ENV_VAR,
  modelPlaceholder: SGLANG_MODEL_PLACEHOLDER,
  overrides: buildProviderReplayFamilyHooks({
    family: "openai-compatible",
    dropReasoningFromHistory: false,
  }),
});
