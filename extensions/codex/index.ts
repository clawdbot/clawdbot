import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { buildCodexProvider } from "./provider.js";
import { createCodexCommand } from "./src/commands.js";

export default definePluginEntry({
  id: "codex",
  name: "Codex",
  description: "Codex app-server harness and Codex-managed GPT model catalog.",
  register(api) {
    api.registerAgentHarness(createCodexAppServerAgentHarness({ pluginConfig: api.pluginConfig }));
    api.registerProvider(buildCodexProvider({ pluginConfig: api.pluginConfig }));
    api.registerCommand(createCodexCommand({ pluginConfig: api.pluginConfig }));
  },
});
