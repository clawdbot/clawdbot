// Firecrawl provider module implements model/runtime integration.
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { buildFirecrawlFreeWebSearchProviderBase } from "../web-search-shared.js";
import { GenericFirecrawlSearchSchema } from "./firecrawl-search-provider.js";

type FirecrawlClientModule = typeof import("./firecrawl-client.js");

let firecrawlClientModulePromise: Promise<FirecrawlClientModule> | undefined;

function loadFirecrawlClientModule(): Promise<FirecrawlClientModule> {
  firecrawlClientModulePromise ??= import("./firecrawl-client.js");
  return firecrawlClientModulePromise;
}

export function createFirecrawlFreeWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildFirecrawlFreeWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using Firecrawl's free hosted starter tier (no API key required). Returns structured results with snippets. Use firecrawl_search for Firecrawl-specific knobs like sources or categories.",
      parameters: GenericFirecrawlSearchSchema,
      execute: async (args) => {
        const { runFirecrawlSearch } = await loadFirecrawlClientModule();
        return await runFirecrawlSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: readPositiveIntegerParam(args, "count", {
            message: "count must be an integer from 1 to 10",
            max: 10,
          }),
          access: "keyless",
        });
      },
    }),
  };
}
