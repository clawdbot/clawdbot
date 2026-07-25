// Volcengine provider module implements model/runtime integration.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { VOLCENGINE_PROVIDER_CATALOG_ENTRIES } from "./provider-catalog.js";

const volcengineProviderDiscovery: ProviderPlugin[] = VOLCENGINE_PROVIDER_CATALOG_ENTRIES.map(
  ({ id, label, buildProvider }) => ({
    id,
    label,
    docsPath: "/providers/models",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: buildProvider(),
      }),
    },
  }),
);

export default volcengineProviderDiscovery;
