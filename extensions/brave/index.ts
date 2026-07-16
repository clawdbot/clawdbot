import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBraveWebSearchProvider } from "./src/brave-web-search-provider.js";

export default definePluginEntry({
  id: "brave",
  name: "Brave Plugin",
  description: "Bundled Brave plugin",
  register(api) {
    api.registerWebSearchProvider(createBraveWebSearchProvider());
  },
});
