import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { createCuaComputerCommands } from "./src/commands.js";

const CuaComputerConfigSchema = z.strictObject({
  driverPath: z.string().trim().min(1).optional(),
});

const configSchema = buildPluginConfigSchema(CuaComputerConfigSchema, {
  uiHints: {
    driverPath: {
      label: "cua-driver path",
      help: "Absolute path or executable name resolved through PATH. Defaults to cua-driver.",
    },
  },
});

export default definePluginEntry({
  id: "cua-computer",
  name: "CUA Computer",
  description: "Experimental cua-driver computer control for Windows and Linux node hosts.",
  configSchema,
  register(api) {
    const parsed = CuaComputerConfigSchema.safeParse(api.pluginConfig ?? {});
    if (!parsed.success) {
      throw new Error(
        `Invalid cua-computer plugin config: ${parsed.error.issues[0]?.message ?? "invalid config"}`,
      );
    }
    for (const command of createCuaComputerCommands({ driverPath: parsed.data.driverPath })) {
      api.registerNodeHostCommand(command);
    }
  },
});
