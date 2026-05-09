import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  SGLANG_DEFAULT_API_KEY_ENV_VAR,
  SGLANG_DEFAULT_BASE_URL,
  SGLANG_MODEL_PLACEHOLDER,
  SGLANG_PROVIDER_LABEL,
  buildSglangProvider,
} from "./api.js";

const PROVIDER_ID = "sglang";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
  id: "sglang",
  name: "SGLang Provider",
  description: "Bundled SGLang provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "SGLang",
      docsPath: "/providers/sglang",
      envVars: ["SGLANG_API_KEY"],
      auth: [
        {
          id: "custom",
          label: SGLANG_PROVIDER_LABEL,
          hint: "Fast self-hosted OpenAI-compatible server",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: SGLANG_PROVIDER_LABEL,
              defaultBaseUrl: SGLANG_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: SGLANG_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: SGLANG_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: SGLANG_PROVIDER_LABEL,
              defaultBaseUrl: SGLANG_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: SGLANG_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: SGLANG_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      catalog: {
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildSglangProvider,
          });
        },
      },
      wizard: {
        setup: {
          choiceId: "sglang",
          choiceLabel: "SGLang",
          choiceHint: "Fast self-hosted OpenAI-compatible server",
          groupId: "sglang",
          groupLabel: "SGLang",
          groupHint: "Fast self-hosted server",
          methodId: "custom",
        },
        modelPicker: {
          label: "SGLang (custom)",
          hint: "Enter SGLang URL + API key + model",
          methodId: "custom",
        },
      },
    });
  },
});
