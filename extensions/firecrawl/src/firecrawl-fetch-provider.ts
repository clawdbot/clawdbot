// Firecrawl provider module implements model/runtime integration.
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import {
  enablePluginInConfig,
  type WebFetchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-fetch-contract";
import { FIRECRAWL_WEB_FETCH_PROVIDER_SHARED } from "./firecrawl-fetch-provider-shared.js";

type FirecrawlClientModule = typeof import("./firecrawl-client.js");

let firecrawlClientModulePromise: Promise<FirecrawlClientModule> | undefined;

function loadFirecrawlClientModule(): Promise<FirecrawlClientModule> {
  firecrawlClientModulePromise ??= import("./firecrawl-client.js");
  return firecrawlClientModulePromise;
}

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
        const maxChars = readPositiveIntegerParam(args, "maxChars");
        const proxy =
          args.proxy === "basic" || args.proxy === "stealth" || args.proxy === "auto"
            ? args.proxy
            : undefined;
        const storeInCache = typeof args.storeInCache === "boolean" ? args.storeInCache : undefined;
        const { runFirecrawlScrape } = await loadFirecrawlClientModule();
        return await runFirecrawlScrape({
          cfg: config,
          url,
          extractMode,
          access: "keyless",
          maxChars,
          ...(proxy ? { proxy } : {}),
          ...(storeInCache !== undefined ? { storeInCache } : {}),
        });
      },
    }),
  };
}
