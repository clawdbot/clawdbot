import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildGoogleStaticCatalogProvider,
  buildGoogleVertexStaticCatalogProvider,
} from "./provider-catalog.js";

const googleProviderDiscovery: ProviderPlugin = {
  id: "google",
  label: "Google AI Studio",
  docsPath: "/providers/models",
  auth: [],
  staticCatalog: {
    order: "simple",
    run: async () => ({
      providers: {
        google: buildGoogleStaticCatalogProvider(),
        "google-vertex": buildGoogleVertexStaticCatalogProvider(),
      },
    }),
  },
};

export default googleProviderDiscovery;
