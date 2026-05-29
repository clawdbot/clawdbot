import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { type WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { buildTavilyWebSearchProviderBase } from "../web-search-shared.js";

type TavilyClientModule = typeof import("./tavily-client.js");

let tavilyClientModulePromise: Promise<TavilyClientModule> | undefined;

function loadTavilyClientModule(): Promise<TavilyClientModule> {
  tavilyClientModulePromise ??= import("./tavily-client.js");
  return tavilyClientModulePromise;
}

const GenericTavilySearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-20).",
      minimum: 1,
      maximum: 20,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildTavilyWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using Tavily. Returns structured results with snippets. Use tavily_search for Tavily-specific options like search depth, topic filtering, or AI answers.",
      parameters: GenericTavilySearchSchema,
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
