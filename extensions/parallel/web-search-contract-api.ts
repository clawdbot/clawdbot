import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createParallelFreeWebSearchProviderBase } from "./src/parallel-free-web-search-provider.shared.js";
import { createParallelWebSearchProviderBase } from "./src/parallel-web-search-provider.shared.js";

export function createParallelWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createParallelWebSearchProviderBase(),
    createTool: () => null,
  };
}

export function createParallelFreeWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createParallelFreeWebSearchProviderBase(),
    createTool: () => null,
  };
}
