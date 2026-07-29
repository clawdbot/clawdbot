/**
 * Brave Search contract provider. It exposes provider metadata without creating
 * the runtime search tool.
 */
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { buildBraveWebSearchProviderBase } from "./web-search-shared.js";

/** Create the Brave provider descriptor for contract checks. */
export function createBraveWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildBraveWebSearchProviderBase(),
    createTool: () => null,
  };
}
