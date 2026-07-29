/**
 * Alibaba Model Studio plugin entry. Registers the DashScope-backed video
 * generation provider.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAlibabaVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "alibaba",
  name: "Alibaba Model Studio Plugin",
  description: "Bundled Alibaba Model Studio video provider plugin",
  register(api) {
    api.registerVideoGenerationProvider(buildAlibabaVideoGenerationProvider());
  },
});
