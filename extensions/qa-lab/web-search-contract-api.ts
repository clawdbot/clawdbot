// Qa Lab API module exposes the deterministic QA web_search contract.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createQaLabWebSearchProviderBase } from "./src/qa-web-search-provider.shared.js";

export function createQaLabWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createQaLabWebSearchProviderBase(),
    createTool: () => null,
  };
}
