// WRouter plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyWRouterConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildWRouterProvider } from "./provider-catalog.js";

const PROVIDER_ID = "wrouter";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "WRouter Provider",
  description: "Bundled WRouter provider plugin",
  manifest,
  provider: {
    label: "WRouter",
    docsPath: "/providers/wrouter",
    manifestAuth: { applyConfig: applyWRouterConfig },
    catalog: {
      buildProvider: buildWRouterProvider,
      buildStaticProvider: buildWRouterProvider,
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
