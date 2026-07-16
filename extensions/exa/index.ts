import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createExaWebSearchProvider } from "./src/exa-web-search-provider.js";

export default definePluginEntry({
  id: "exa",
  name: "Exa Plugin",
  description: "Bundled Exa web search plugin",
  register(api) {
    api.registerWebSearchProvider(createExaWebSearchProvider());
  },
});
