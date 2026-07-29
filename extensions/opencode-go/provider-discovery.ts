// Opencode Go provider module exposes offline catalog metadata to core discovery.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildStaticOpencodeGoProviderConfig } from "./provider-catalog.js";

const opencodeGoProviderDiscovery: ProviderPlugin = {
  id: "opencode-go",
  label: "OpenCode Go",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildStaticOpencodeGoProviderConfig(),
    }),
  },
};

export default opencodeGoProviderDiscovery;
