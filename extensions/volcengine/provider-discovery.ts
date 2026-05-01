import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildDoubaoCodingProvider, buildDoubaoProvider } from "./provider-catalog.js";

const volcengineProviderDiscovery: ProviderPlugin[] = [
  {
    id: "volcengine",
    label: "Volcengine",
    docsPath: "/providers/models",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: buildDoubaoProvider(),
      }),
    },
  },
  {
    id: "volcengine-plan",
    label: "Volcengine Plan",
    docsPath: "/providers/models",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: buildDoubaoCodingProvider(),
      }),
    },
  },
];

export default volcengineProviderDiscovery;
