import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Tavily provider module implements model/runtime integration.
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import {
  buildTavilyWebSearchProviderBase,
  TAVILY_GENERIC_SEARCH_DESCRIPTION,
  TAVILY_GENERIC_SEARCH_SCHEMA,
} from "../web-search-shared.js";

const loadTavilyClientModule = createLazyRuntimeModule(() => import("./tavily-client.js"));

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildTavilyWebSearchProviderBase(),
    createTool: (ctx) => ({
      description: TAVILY_GENERIC_SEARCH_DESCRIPTION,
      parameters: TAVILY_GENERIC_SEARCH_SCHEMA,
      execute: async (args) => {
        const { runTavilySearch } = await loadTavilyClientModule();
        return await runTavilySearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          maxResults: readPositiveIntegerParam(args, "count", {
            message: "count must be an integer from 1 to 20",
            max: 20,
          }),
        });
      },
    }),
  };
}
