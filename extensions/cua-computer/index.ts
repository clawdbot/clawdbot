import { registerComputerUseProvider } from "openclaw/plugin-sdk/computer-use";
import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { createCuaComputerProvider } from "./src/commands.js";

const CuaComputerConfigSchema = z.strictObject({
  // Keep the shipped daemon setting as a named no-op: strict validation accepts
  // existing config, but direct SDK commands never receive a binary path.
  driverPath: z.string().optional(),
});

const configSchema = buildPluginConfigSchema(CuaComputerConfigSchema);

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
    registerComputerUseProvider(api, createCuaComputerProvider());
  },
});
