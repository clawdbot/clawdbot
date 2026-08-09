/**
 * Z.AI Search contract provider. Exposes provider metadata without creating
 * the runtime search tool.
 */
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { buildZaiWebSearchProviderBase } from "./web-search-shared.js";

/** Create the Z.AI provider descriptor for contract checks. */
export function createZaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildZaiWebSearchProviderBase(),
    createTool: () => null,
  };
}
