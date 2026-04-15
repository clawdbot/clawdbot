import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "./src/tool-config-shared.js";

export default definePluginEntry({
  id: "xai",
  name: "xAI Setup",
  description: "Lightweight xAI setup hooks",
  register(api) {
    api.registerAutoEnableProbe(({ config }) => {
      const pluginConfig = config.plugins?.entries?.xai?.config;
      const web = config.tools?.web as Record<string, unknown> | undefined;
      if (
        isRecord(web?.x_search) ||
        (isRecord(pluginConfig) &&
          (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution)))
      ) {
        return "xai tool configured";
      }
      return null;
    });
  },
});
