import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { createCuaComputerCommands } from "./src/commands.js";

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
    for (const command of createCuaComputerCommands()) {
      api.registerNodeHostCommand(command);
    }
    // computer.act is dangerous-by-default and therefore also requires the
    // operator's explicit gateway.nodes.commands.allow entry. The plugin
    // policy is the final Gateway guard and the only path that may forward the
    // already-allowlisted invocation to the paired node.
    api.registerNodeInvokePolicy({
      commands: ["computer.act"],
      dangerous: true,
      handle: async (ctx) => await ctx.invokeNode(),
    });
  },
});
