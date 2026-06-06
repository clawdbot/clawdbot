import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createParallelWebSearchProviderBase } from "./src/parallel-web-search-provider.shared.js";

export function createParallelWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createParallelWebSearchProviderBase(),
    createTool: () => null,
  };
}
