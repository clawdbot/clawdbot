import { type WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  createPerplexityWebSearchProviderBase,
  resolvePerplexityWebSearchRuntimeMetadata,
} from "./src/perplexity-web-search-provider.shared.js";

export function createPerplexityWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createPerplexityWebSearchProviderBase(),
    resolveRuntimeMetadata: resolvePerplexityWebSearchRuntimeMetadata,
    createTool: () => null,
  };
}
