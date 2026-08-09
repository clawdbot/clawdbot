/**
 * Z.AI web-search provider factory. Builds the agent tool definition and
 * lazy-loads MCP execution only when a search is run.
 */
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import type {
  SearchConfigRecord,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";
import { buildZaiWebSearchProviderBase } from "../web-search-shared.js";

const loadZaiWebSearchRuntime = createLazyRuntimeModule(
  () => import("./zai-web-search-provider.runtime.js"),
);

const ZaiSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query string.",
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    country: {
      type: "string",
      description:
        "2-letter country code for region-specific results (e.g., 'US', 'CN', 'AU'). Affects result localization.",
    },
    freshness: {
      type: "string",
      description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
    },
  },
} satisfies Record<string, unknown>;

function createZaiToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Z.AI Web Search (MCP web_search_prime, included in the GLM Coding Plan). Returns titles, URLs, and content summaries optimized for LLM processing.",
    parameters: ZaiSearchSchema,
    execute: async (args, context) => {
      context?.signal?.throwIfAborted();
      const { executeZaiSearch } = await loadZaiWebSearchRuntime();
      return await executeZaiSearch(args, searchConfig, {
        signal: context?.signal,
      });
    },
  };
}

/** Create the runtime Z.AI Search provider descriptor. */
export function createZaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildZaiWebSearchProviderBase(),
    createTool: (ctx) =>
      createZaiToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "zai-search",
          resolveProviderWebSearchPluginConfig(ctx.config, "zai-search"),
          { mirrorApiKeyToTopLevel: true },
        ),
      ),
  };
}
