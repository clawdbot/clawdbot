import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTavilyExtractTool } from "./src/tavily-extract-tool.js";
import { createTavilyWebSearchProvider } from "./src/tavily-search-provider.js";
import { createTavilySearchTool } from "./src/tavily-search-tool.js";

export default definePluginEntry({
  id: "tavily",
  name: "Tavily Plugin",
  description: "Bundled Tavily search and extract plugin",
  register(api) {
    api.registerWebSearchProvider(createTavilyWebSearchProvider());
    api.registerTool((ctx) => createTavilySearchTool(api, ctx), { name: "tavily_search" });
    api.registerTool((ctx) => createTavilyExtractTool(api, ctx), { name: "tavily_extract" });
  },
});
