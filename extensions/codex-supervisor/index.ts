/**
 * Bundled plugin entry that exposes Codex app-server supervisor tools to
 * OpenClaw agents.
 */
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCodexSupervisorCli } from "./src/cli.js";
import {
  CodexSupervisorPluginConfigSchema,
  resolveCodexSupervisorPluginConfig,
} from "./src/config.js";
import { createCodexSupervisorTools } from "./src/plugin-tools.js";
import {
  createCodexSessionCatalogNodeHostCommands,
  createCodexSessionCatalogNodeInvokePolicies,
  createCodexSessionCatalogSupervisor,
  registerCodexSessionCatalogGateway,
} from "./src/session-catalog.js";
import { CodexSupervisor } from "./src/supervisor.js";

export default definePluginEntry({
  id: "codex-supervisor",
  name: "Codex Supervisor",
  description: "Supervise Codex app-server sessions from OpenClaw.",
  configSchema: buildJsonPluginConfigSchema(
    CodexSupervisorPluginConfigSchema as unknown as Parameters<
      typeof buildJsonPluginConfigSchema
    >[0],
  ),
  register(api) {
    const config = resolveCodexSupervisorPluginConfig(api.pluginConfig);
    const supervisor = new CodexSupervisor(config.endpoints);
    // Catalog reads use a dedicated stdio app-server, so enabling the plugin
    // works without replacing the live-control daemon endpoint contract.
    const catalogSupervisor = createCodexSessionCatalogSupervisor(config.endpoints);
    api.lifecycle.registerRuntimeLifecycle({
      id: "codex-supervisor",
      description: "Close Codex supervisor app-server connections.",
      cleanup: async () => {
        await Promise.all([supervisor.close(), catalogSupervisor.close()]);
      },
    });
    for (const command of createCodexSessionCatalogNodeHostCommands(catalogSupervisor)) {
      api.registerNodeHostCommand(command);
    }
    for (const policy of createCodexSessionCatalogNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
    registerCodexSessionCatalogGateway({ api, supervisor: catalogSupervisor });
    api.registerCli(({ program }) => registerCodexSupervisorCli(program), {
      descriptors: [
        {
          name: "codex",
          description: "Inspect Codex sessions across the Gateway and paired nodes",
          hasSubcommands: true,
        },
      ],
    });
    for (const tool of createCodexSupervisorTools({
      supervisor,
      policy: {
        allowRawTranscripts: config.allowRawTranscripts,
        allowWriteControls: config.allowWriteControls,
      },
    })) {
      api.registerTool(tool);
    }
  },
});
