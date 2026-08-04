// Opencode Zen provider module exposes offline catalog metadata to core discovery.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildStaticOpencodeZenProviderConfig,
  resolveOpencodeZenSyntheticAuth,
} from "./provider-catalog.js";

const opencodeProviderDiscovery: ProviderPlugin = {
  id: "opencode",
  label: "OpenCode Zen",
  docsPath: "/providers/models",
  auth: [],
  resolveSyntheticAuth: (ctx) => resolveOpencodeZenSyntheticAuth(ctx),
  staticCatalog: {
    order: "simple",
    run: async () => ({
      provider: buildStaticOpencodeZenProviderConfig(),
    }),
  },
};

export default opencodeProviderDiscovery;
