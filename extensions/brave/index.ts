/**
 * Brave Search plugin entry. It registers the Brave web-search provider and
 * keeps runtime HTTP execution lazy.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBraveWebSearchProvider } from "./src/brave-web-search-provider.js";

/** Plugin entry for Brave Search. */
export default definePluginEntry({
  id: "brave",
  name: "Brave Plugin",
  description: "Bundled Brave plugin",
  register(api) {
    api.registerWebSearchProvider(createBraveWebSearchProvider());
  },
});
