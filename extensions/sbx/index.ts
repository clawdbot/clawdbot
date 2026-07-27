// Sbx plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { createSbxSandboxBackendFactory, createSbxSandboxBackendManager } from "./src/backend.js";
import { createSbxPluginConfigSchema, resolveSbxPluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "sbx",
  name: "Docker Sandboxes (sbx)",
  description: "Docker Sandboxes (sbx CLI) sandbox backend for agent exec and file tools.",
  configSchema: createSbxPluginConfigSchema(),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveSbxPluginConfig(api.pluginConfig);
    registerSandboxBackend("sbx", {
      factory: createSbxSandboxBackendFactory({ pluginConfig }),
      manager: createSbxSandboxBackendManager({ pluginConfig }),
      resolveWorkdir: ({ workspaceDir }) => workspaceDir,
    });
  },
});
