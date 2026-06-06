import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createParallelWebSearchProvider } from "./src/parallel-web-search-provider.js";

export default definePluginEntry({
  id: "parallel",
  name: "Parallel Plugin",
  description: "Bundled Parallel web search plugin",
  register(api) {
    api.registerWebSearchProvider(createParallelWebSearchProvider());
  },
});
