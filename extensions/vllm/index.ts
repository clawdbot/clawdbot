import { defineSelfHostedOpenAICompatibleProvider } from "openclaw/plugin-sdk/provider-model-shared";
import {
  VLLM_DEFAULT_API_KEY_ENV_VAR,
  VLLM_DEFAULT_BASE_URL,
  VLLM_MODEL_PLACEHOLDER,
  VLLM_PROVIDER_LABEL,
} from "./api.js";
import { wrapVllmProviderStream } from "./stream.js";
import { resolveThinkingProfile } from "./thinking-policy.js";

export default defineSelfHostedOpenAICompatibleProvider({
  id: "vllm",
  label: VLLM_PROVIDER_LABEL,
  hint: "Local/self-hosted OpenAI-compatible server",
  groupHint: "Local/self-hosted OpenAI-compatible",
  defaultBaseUrl: VLLM_DEFAULT_BASE_URL,
  apiKeyEnvVar: VLLM_DEFAULT_API_KEY_ENV_VAR,
  modelPlaceholder: VLLM_MODEL_PLACEHOLDER,
  overrides: {
    buildUnknownModelHint: () =>
      "vLLM requires authentication to be registered as a provider. " +
      'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
      "See: https://docs.openclaw.ai/providers/vllm",
    resolveThinkingProfile,
    wrapStreamFn: wrapVllmProviderStream,
  },
});
