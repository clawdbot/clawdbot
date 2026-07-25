/**
 * Static provider discovery entries for BytePlus manifest-backed catalogs.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { BYTEPLUS_PROVIDER_CATALOG_ENTRIES } from "./provider-catalog.js";

const bytePlusProviderDiscovery: ProviderPlugin[] = BYTEPLUS_PROVIDER_CATALOG_ENTRIES.map(
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

export default bytePlusProviderDiscovery;
