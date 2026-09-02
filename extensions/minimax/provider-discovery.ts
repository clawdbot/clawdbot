// Minimax provider module implements model/runtime integration.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { buildMinimaxPortalProvider, buildMinimaxProvider } from "./provider-catalog.js";

const minimaxProviderDiscovery: ProviderPlugin[] = [
  {
    id: "minimax",
    label: "MiniMax",
    docsPath: "/providers/minimax",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async (ctx) => ({ providers: { minimax: buildMinimaxProvider(ctx.env) } }),
    },
  },
  {
    id: "minimax-portal",
    label: "MiniMax",
    docsPath: "/providers/minimax",
    auth: [],
    staticCatalog: {
      order: "simple",
      run: async (ctx) => ({
        providers: { "minimax-portal": buildMinimaxPortalProvider(ctx.env) },
      }),
    },
  },
];

export default minimaxProviderDiscovery;
