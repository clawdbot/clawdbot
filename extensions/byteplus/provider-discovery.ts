import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildBytePlusCodingProvider, buildBytePlusProvider } from "./provider-catalog.js";

export const bytePlusProviderDiscovery: ProviderPlugin[] = [
  {
    id: "byteplus",
    label: "BytePlus",
    docsPath: "/providers/models",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: buildBytePlusProvider(),
      }),
    },
  },
  {
    id: "byteplus-plan",
    label: "BytePlus Plan",
    docsPath: "/providers/models",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: buildBytePlusCodingProvider(),
      }),
    },
  },
];

export default bytePlusProviderDiscovery;
