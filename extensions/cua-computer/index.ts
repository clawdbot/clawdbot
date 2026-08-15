import { registerComputerUseProvider } from "openclaw/plugin-sdk/computer-use";
import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { registerCuaDriverDoctorChecks } from "./api.js";
import { createCuaComputerProvider } from "./src/commands.js";
import { verifyInstalledCuaDriverArtifacts } from "./src/driver-artifacts.js";
import { createCuaComputerNodeInvokePolicy } from "./src/node-invoke-policy.js";

const CuaComputerConfigSchema = z.strictObject({
  // Keep the shipped daemon setting as a named no-op: strict validation accepts
  // existing config, but direct SDK commands never receive a binary path.
  driverPath: z.string().optional(),
});

const configSchema = buildPluginConfigSchema(CuaComputerConfigSchema);

export default definePluginEntry({
  id: "cua-computer",
  name: "CUA Computer",
  description: "Experimental CUA Driver computer control for macOS, Windows, and Linux node hosts.",
  configSchema,
  register(api) {
    registerCuaDriverDoctorChecks();
    const parsed = CuaComputerConfigSchema.safeParse(api.pluginConfig ?? {});
    if (!parsed.success) {
      throw new Error(
        `Invalid cua-computer plugin config: ${parsed.error.issues[0]?.message ?? "invalid config"}`,
      );
    }
    const artifactVerification = verifyInstalledCuaDriverArtifacts();
    if (!artifactVerification.ok) {
      api.logger?.error(artifactVerification.diagnostic);
    }
    registerComputerUseProvider(api, createCuaComputerProvider());
    // Dangerous plugin command: excluded from default allowlists, and the
    // Gateway fails closed when this policy registration is missing.
    api.registerNodeInvokePolicy(createCuaComputerNodeInvokePolicy());
  },
});
