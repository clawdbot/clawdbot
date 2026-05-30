import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { NOVITA_DEFAULT_MODEL_REF } from "./models.js";
import { buildNovitaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "novita";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NovitaAI Provider",
  description: "Bundled NovitaAI provider plugin",
  provider: {
    label: "NovitaAI",
    docsPath: "/providers/novita",
    aliases: ["novita-ai", "novitaai"],
    envVars: ["NOVITA_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "NovitaAI API key",
        hint: "OpenAI-compatible NovitaAI endpoint",
        optionKey: "novitaApiKey",
        flagName: "--novita-api-key",
        envVar: "NOVITA_API_KEY",
        promptMessage: "Enter NovitaAI API key",
        defaultModel: NOVITA_DEFAULT_MODEL_REF,
        noteTitle: "NovitaAI",
        noteMessage: "Manage API keys at https://novita.ai/settings/key-management",
      },
    ],
    catalog: {
      buildProvider: buildNovitaProvider,
      buildStaticProvider: buildNovitaProvider,
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
