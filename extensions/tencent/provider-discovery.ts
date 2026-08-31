// Tencent provider module implements model/runtime integration.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildTokenHubProvider, buildTokenPlanProvider } from "./provider-catalog.js";

const tencentProviderDiscovery: ProviderPlugin[] = [
  {
    id: "tencent-tokenhub",
    label: "Tencent TokenHub",
    docsPath: "/providers/tencent",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: buildTokenHubProvider(),
      }),
    },
  },
  {
    id: "tencent-tokenplan",
    label: "Tencent TokenPlan",
    docsPath: "/providers/tencent",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async () => ({
        provider: buildTokenPlanProvider(),
      }),
    },
  },
];

export default tencentProviderDiscovery;
