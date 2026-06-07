import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createParallelFreeWebSearchProvider } from "./src/parallel-free-web-search-provider.js";
import { createParallelWebSearchProvider } from "./src/parallel-web-search-provider.js";

export default definePluginEntry({
  id: "parallel",
  name: "Parallel Plugin",
  description: "Bundled Parallel web search plugin",
  register(api) {
    // Free hosted Search MCP (keyless, zero-config default) and the paid v1 REST
    // API (requires PARALLEL_API_KEY) are registered as two distinct providers.
    api.registerWebSearchProvider(createParallelFreeWebSearchProvider());
    api.registerWebSearchProvider(createParallelWebSearchProvider());
  },
});
