import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { createCuaComputerCommands } from "./src/commands.js";

const CuaComputerConfigSchema = z.strictObject({});

const configSchema = buildPluginConfigSchema(CuaComputerConfigSchema, {
  uiHints: {},
});

export default definePluginEntry({
  id: "cua-computer",
  name: "CUA Computer",
  description: "Experimental CUA Driver SDK computer control for Windows and Linux node hosts.",
  configSchema,
  register(api) {
    const parsed = CuaComputerConfigSchema.safeParse(api.pluginConfig ?? {});
    if (!parsed.success) {
      throw new Error(
        `Invalid cua-computer plugin config: ${parsed.error.issues[0]?.message ?? "invalid config"}`,
      );
    }
    for (const command of createCuaComputerCommands()) {
      api.registerNodeHostCommand(command);
    }
  },
});
