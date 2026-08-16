// LLMTR plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { LLMTR_DEFAULT_MODEL_REF } from "./models.js";
import { buildLlmtrProvider, buildStaticLlmtrProvider } from "./provider-catalog.js";

const PROVIDER_ID = "llmtr";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "LLMTR Provider",
  description: "OpenClaw LLMTR provider plugin",
  provider: {
    label: "LLMTR",
    docsPath: "/providers/llmtr",
    envVars: ["LLMTR_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "LLMTR API key",
        hint: "OpenAI-compatible AI gateway with Turkey-hosted routes",
        optionKey: "llmtrApiKey",
        flagName: "--llmtr-api-key",
        envVar: "LLMTR_API_KEY",
        promptMessage: "Enter LLMTR API key",
        defaultModel: LLMTR_DEFAULT_MODEL_REF,
        noteTitle: "LLMTR",
        noteMessage: "Manage API keys at https://llmtr.com/dashboard",
      },
    ],
    catalog: {
      buildProvider: buildLlmtrProvider,
      buildStaticProvider: buildStaticLlmtrProvider,
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
