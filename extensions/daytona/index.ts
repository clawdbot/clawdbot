// Daytona sandbox plugin entry: registers the daytona sandbox backend.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createDaytonaSandboxBackendFactory,
  createDaytonaSandboxBackendManager,
} from "./src/backend.js";
import { createDaytonaPluginConfigSchema, resolveDaytonaPluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "daytona",
  name: "Daytona Sandbox",
  description: "Daytona cloud sandbox runtime for agent exec and file tools.",
  configSchema: createDaytonaPluginConfigSchema(),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveDaytonaPluginConfig(api.pluginConfig);
    registerSandboxBackend("daytona", {
      factory: createDaytonaSandboxBackendFactory({ pluginConfig, hostConfig: api.config }),
      manager: createDaytonaSandboxBackendManager({ pluginConfig, hostConfig: api.config }),
      resolveWorkdir: () => pluginConfig.remoteWorkspaceDir,
    });
  },
});
