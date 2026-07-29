// Firecrawl API module exposes the plugin public contract.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import {
  buildFirecrawlFreeWebSearchProviderBase,
  buildFirecrawlWebSearchProviderBase,
} from "./web-search-shared.js";

export function createFirecrawlWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildFirecrawlWebSearchProviderBase(),
    createTool: () => null,
  };
}

export function createFirecrawlFreeWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildFirecrawlFreeWebSearchProviderBase(),
    createTool: () => null,
  };
}
