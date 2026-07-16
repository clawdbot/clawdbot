import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch";
import { enablePluginInConfig } from "openclaw/plugin-sdk/provider-web-fetch";
import { runFirecrawlScrape } from "./firecrawl-client.js";
import { FIRECRAWL_WEB_FETCH_PROVIDER_SHARED } from "./firecrawl-fetch-provider-shared.js";

export function createFirecrawlWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...FIRECRAWL_WEB_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, "firecrawl").config,
    createTool: ({ config }) => ({
      description: "Fetch a page using Firecrawl.",
      parameters: {},
      execute: async (args) => {
        const url = typeof args.url === "string" ? args.url : "";
        const extractMode = args.extractMode === "text" ? "text" : "markdown";
        const maxChars =
          typeof args.maxChars === "number" && Number.isFinite(args.maxChars)
            ? Math.floor(args.maxChars)
            : undefined;
        const proxy =
          args.proxy === "basic" || args.proxy === "stealth" || args.proxy === "auto"
            ? args.proxy
            : undefined;
        const storeInCache = typeof args.storeInCache === "boolean" ? args.storeInCache : undefined;
        return await runFirecrawlScrape({
          cfg: config,
          url,
          extractMode,
          maxChars,
          ...(proxy ? { proxy } : {}),
          ...(storeInCache !== undefined ? { storeInCache } : {}),
        });
      },
    }),
  };
}
