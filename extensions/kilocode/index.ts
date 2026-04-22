import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import { KILOCODE_THINKING_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import { applyKilocodeConfig, KILOCODE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildKilocodeProvider, buildKilocodeProviderWithDiscovery } from "./provider-catalog.js";

const PROVIDER_ID = "kilocode";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Kilo Gateway Provider",
  description: "Bundled Kilo Gateway provider plugin",
  provider: {
    label: "Kilo Gateway",
    docsPath: "/providers/kilocode",
    auth: [
      {
        methodId: "api-key",
        label: "Kilo Gateway API key",
        hint: "API key (OpenRouter-compatible)",
        optionKey: "kilocodeApiKey",
        flagName: "--kilocode-api-key",
        envVar: "KILOCODE_API_KEY",
        promptMessage: "Enter Kilo Gateway API key",
        defaultModel: KILOCODE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyKilocodeConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildKilocodeProviderWithDiscovery,
      buildStaticProvider: buildKilocodeProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
    ...KILOCODE_THINKING_STREAM_HOOKS,
    isCacheTtlEligible: (ctx) => ctx.modelId.startsWith("anthropic/"),
  },
});
