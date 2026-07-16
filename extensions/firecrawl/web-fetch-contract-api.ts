import {
  enablePluginInConfig,
  type WebFetchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-fetch-contract";
import { FIRECRAWL_WEB_FETCH_PROVIDER_SHARED } from "./src/firecrawl-fetch-provider-shared.js";

export function createFirecrawlWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...FIRECRAWL_WEB_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, "firecrawl").config,
    createTool: () => null,
  };
}
