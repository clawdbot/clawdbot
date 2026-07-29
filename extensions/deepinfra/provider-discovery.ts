// Deepinfra provider module implements model/runtime integration.
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildDeepInfraApiKeyCatalog, buildStaticDeepInfraProvider } from "./provider-catalog.js";

const PROVIDER_ID = "deepinfra";

const deepinfraProviderDiscovery: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "DeepInfra",
  docsPath: "/providers/deepinfra",
  auth: [],
  catalog: {
    order: "simple",
    run: (ctx: ProviderCatalogContext) => buildDeepInfraApiKeyCatalog(ctx),
  },
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildStaticDeepInfraProvider(),
    }),
  },
};

export default deepinfraProviderDiscovery;
