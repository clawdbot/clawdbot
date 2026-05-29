import { type WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { buildBraveWebSearchProviderBase } from "./web-search-shared.js";

export function createBraveWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildBraveWebSearchProviderBase(),
    createTool: () => null,
  };
}
