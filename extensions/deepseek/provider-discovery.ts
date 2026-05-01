import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildDeepSeekProvider } from "./provider-catalog.js";

const deepSeekProviderDiscovery: ProviderPlugin = {
  id: "deepseek",
  label: "DeepSeek",
  docsPath: "/providers/deepseek",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildDeepSeekProvider(),
    }),
  },
};

export default deepSeekProviderDiscovery;
