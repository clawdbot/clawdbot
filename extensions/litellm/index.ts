import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createProviderApiKeyAuthMethod,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog-shared";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";
import { applyLitellmConfig, LITELLM_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildLitellmProvider } from "./provider-catalog.js";

const PROVIDER_ID = "litellm";

function applyCustomBaseUrlForNonInteractiveSetup(
  cfg: OpenClawConfig,
  customBaseUrl: unknown,
): OpenClawConfig {
  const baseUrl = normalizeOptionalSecretInput(customBaseUrl)?.replace(/\/+$/, "");
  if (!baseUrl) {
    return cfg;
  }
  const existingProvider = cfg.models?.providers?.[PROVIDER_ID];
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        [PROVIDER_ID]: {
          ...existingProvider,
          baseUrl,
          models: existingProvider?.models ?? [],
        },
      },
    },
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "LiteLLM Provider",
  description: "Bundled LiteLLM provider plugin",
  register(api: OpenClawPluginApi) {
    const apiKeyAuth = createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "api-key",
      label: "LiteLLM API key",
      hint: "Unified gateway for 100+ LLM providers",
      optionKey: "litellmApiKey",
      flagName: "--litellm-api-key",
      envVar: "LITELLM_API_KEY",
      promptMessage: "Enter LiteLLM API key",
      defaultModel: LITELLM_DEFAULT_MODEL_REF,
      applyConfig: (cfg) => applyLitellmConfig(cfg),
      noteTitle: "LiteLLM",
      noteMessage: [
        "LiteLLM provides a unified API to 100+ LLM providers.",
        "Get your API key from your LiteLLM proxy or https://litellm.ai",
        "Default proxy runs on http://localhost:4000",
      ].join("\n"),
      wizard: {
        choiceId: `${PROVIDER_ID}-api-key`,
        choiceLabel: "LiteLLM API key",
        groupId: PROVIDER_ID,
        groupLabel: "LiteLLM",
        groupHint: "Unified LLM gateway (100+ providers)",
        methodId: "api-key",
      },
    });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "LiteLLM",
      docsPath: "/providers/litellm",
      envVars: ["LITELLM_API_KEY"],
      auth: [
        {
          ...apiKeyAuth,
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const runNonInteractive = apiKeyAuth.runNonInteractive;
            if (!runNonInteractive) {
              return null;
            }
            return await runNonInteractive({
              ...ctx,
              config: applyCustomBaseUrlForNonInteractiveSetup(ctx.config, ctx.opts.customBaseUrl),
            });
          },
        },
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildLitellmProvider,
            allowExplicitBaseUrl: true,
          }),
      },
    });
    api.registerImageGenerationProvider(buildLitellmImageGenerationProvider());
  },
});
