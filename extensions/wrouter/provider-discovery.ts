// WRouter provider discovery entry.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildWRouterProvider } from "./provider-catalog.js";

const wrouterProviderDiscovery: ProviderPlugin = {
  id: "wrouter",
  label: "WRouter",
  docsPath: "/providers/wrouter",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildWRouterProvider(),
    }),
  },
};

export default wrouterProviderDiscovery;
