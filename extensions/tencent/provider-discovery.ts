import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildTokenHubProvider } from "./provider-catalog.js";

export const tencentProviderDiscovery: ProviderPlugin = {
  id: "tencent-tokenhub",
  label: "Tencent TokenHub",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildTokenHubProvider(),
    }),
  },
};

export default tencentProviderDiscovery;
