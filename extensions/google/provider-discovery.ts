// Google provider module implements model/runtime integration.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildGoogleStaticCatalogProvider,
  buildGoogleVertexStaticCatalogProvider,
} from "./provider-catalog.js";
import { resolveGoogleVertexConfigApiKey } from "./vertex-adc.js";

const googleProviderDiscovery: ProviderPlugin = {
  id: "google",
  label: "Google AI Studio",
  docsPath: "/providers/models",
  auth: [],
  resolveConfigApiKey: ({ provider, env }) =>
    provider === "google-vertex" ? resolveGoogleVertexConfigApiKey(env) : undefined,
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
