import { defineSelfHostedOpenAICompatibleProvider } from "openclaw/plugin-sdk/provider-model-shared";
import {
  FREETOKEN_DEFAULT_API_KEY_ENV_VAR,
  FREETOKEN_DEFAULT_BASE_URL,
  FREETOKEN_MODEL_PLACEHOLDER,
  FREETOKEN_PROVIDER_LABEL,
} from "./api.js";

export default defineSelfHostedOpenAICompatibleProvider({
  id: "freetoken",
  label: FREETOKEN_PROVIDER_LABEL,
  hint: "Edge-native OpenAI-compatible MoE server",
  groupHint: "Local/self-hosted MoE inference",
  defaultBaseUrl: FREETOKEN_DEFAULT_BASE_URL,
  apiKeyEnvVar: FREETOKEN_DEFAULT_API_KEY_ENV_VAR,
  modelPlaceholder: FREETOKEN_MODEL_PLACEHOLDER,
  overrides: {
    buildUnknownModelHint: () =>
      "FreeToken requires authentication to be registered as a provider. " +
      "Set FREETOKEN_API_KEY (any value works when the server has no auth) or run " +
      '"openclaw configure". See: https://docs.openclaw.ai/providers/freetoken',
  },
});
