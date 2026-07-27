import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Tavily API module exposes the plugin public contract.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  buildTavilyWebSearchProviderBase,
  TAVILY_GENERIC_SEARCH_DESCRIPTION,
  TAVILY_GENERIC_SEARCH_SCHEMA,
} from "./web-search-shared.js";

const loadTavilySearchProviderModule = createLazyRuntimeModule(
  () => import("./src/tavily-search-provider.js"),
);

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildTavilyWebSearchProviderBase(),
    createTool: (ctx) => ({
      description: TAVILY_GENERIC_SEARCH_DESCRIPTION,
      parameters: TAVILY_GENERIC_SEARCH_SCHEMA,
      execute: async (args) => {
        const { createTavilyWebSearchProvider: createRuntimeProvider } =
          await loadTavilySearchProviderModule();
        const tool = createRuntimeProvider().createTool(ctx);
        if (!tool) {
          throw new Error("Tavily web_search provider did not create a runtime tool.");
        }
        return await tool.execute(args);
      },
    }),
  };
}
