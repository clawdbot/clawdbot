/**
 * Bundled plugin entry that exposes Codex app-server supervisor tools to
 * OpenClaw agents.
 */
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  CodexSupervisorPluginConfigSchema,
  resolveCodexSupervisorPluginConfig,
} from "./src/config.js";
import { createCodexSupervisorTools } from "./src/plugin-tools.js";
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
    api.lifecycle.registerRuntimeLifecycle({
      id: "codex-supervisor",
      description: "Close Codex supervisor app-server connections.",
      cleanup: () => supervisor.close(),
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
