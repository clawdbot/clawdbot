/**
 * Nexforce Router provider plugin entrypoint.
 */
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyNexforceConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildNexforceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nexforce";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Nexforce Router Provider",
  description: "Bundled Nexforce Router provider plugin",
  manifest,
  provider: {
    label: "Nexforce Router",
    docsPath: "/providers/nexforce",
    manifestAuth: {
      hint: "API key",
      preserveExistingPrimary: true,
      applyConfig: applyNexforceConfig,
      noteTitle: "Nexforce Router",
      noteMessage: [
        "One API key reaches Anthropic, OpenAI, Google, DeepSeek, Moonshot, Zhipu, and Cloudflare Workers AI models.",
        "Get an API key at: https://marketplace.nexforce.ai/workspace/ai-gateway/ai-gateway-keys",
      ].join("\n"),
    },
    catalog: {
      buildProvider: buildNexforceProvider,
      buildStaticProvider: buildNexforceProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
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
  },
});
