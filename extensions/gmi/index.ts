// Gmi plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { GMI_DEFAULT_MODEL_REF } from "./models.js";
import { buildGmiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "gmi";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "GMI Cloud Provider",
  description: "Bundled GMI Cloud provider plugin",
  provider: {
    label: "GMI Cloud",
    docsPath: "/providers/gmi",
    aliases: ["gmi-cloud", "gmicloud"],
    envVars: ["GMI_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "GMI Cloud API key",
        hint: "OpenAI-compatible GMI Cloud endpoint",
        optionKey: "gmiApiKey",
        flagName: "--gmi-api-key",
        envVar: "GMI_API_KEY",
        promptMessage: "Enter GMI Cloud API key",
        defaultModel: GMI_DEFAULT_MODEL_REF,
        noteTitle: "GMI Cloud",
        noteMessage: "Manage API keys at https://www.gmicloud.ai/",
      },
    ],
    catalog: {
      buildProvider: buildGmiProvider,
      buildStaticProvider: buildGmiProvider,
      allowExplicitBaseUrl: true,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});
