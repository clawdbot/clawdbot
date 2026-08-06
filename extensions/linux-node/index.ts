import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createLinuxNodeCommands } from "./src/commands.js";
import { createLinuxNodePluginConfigSchema, resolveLinuxNodePluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "linux-node",
  name: "Linux Node",
  description: "Desktop notifications, camera capture, and location for Linux node hosts.",
  configSchema: createLinuxNodePluginConfigSchema,
  register(api) {
    const config = resolveLinuxNodePluginConfig(api.pluginConfig);
    for (const command of createLinuxNodeCommands({ config })) {
      api.registerNodeHostCommand(command);
    }

    api.registerNodeInvokePolicy({
      commands: ["camera.list", "location.get"],
      defaultPlatforms: ["linux"],
      handle: async (ctx) => await ctx.invokeNode(),
    });
    api.registerNodeInvokePolicy({
      commands: ["camera.snap", "camera.clip"],
      dangerous: true,
      handle: async (ctx) => await ctx.invokeNode(),
    });
  },
});
