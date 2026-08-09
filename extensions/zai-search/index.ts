/**
 * Z.AI Web Search plugin entry. Registers the Z.AI web-search provider which
 * uses the MCP `web_search_prime` endpoint included in the GLM Coding Plan.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createZaiWebSearchProvider } from "./src/zai-web-search-provider.js";

/** Plugin entry for Z.AI Web Search. */
export default definePluginEntry({
  id: "zai-search",
  name: "Z.AI Web Search Plugin",
  description: "Z.AI Web Search provider using MCP web_search_prime",
  register(api) {
    api.registerWebSearchProvider(createZaiWebSearchProvider());
  },
});
