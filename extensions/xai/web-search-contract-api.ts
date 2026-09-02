// Xai API module exposes the plugin public contract.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { buildXaiWebSearchProviderBase } from "./web-search-provider-shared.js";

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildXaiWebSearchProviderBase(),
    createTool: () => null,
  };
}
