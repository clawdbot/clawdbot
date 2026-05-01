import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildCodexProvider } from "./provider.js";
import { createCodexCommand } from "./src/commands.js";
import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
} from "./src/conversation-binding.js";
import { buildCodexMigrationProvider } from "./src/migration/provider.js";

export default definePluginEntry({
  id: "codex",
  name: "Codex",
  description: "Codex app-server harness and Codex-managed GPT model catalog.",
  register(api) {
    const resolveCurrentPluginConfig = () =>
      resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "codex",
        api.pluginConfig as Record<string, unknown>,
      ) ?? api.pluginConfig;
    api.registerAgentHarness(createCodexAppServerAgentHarness({ pluginConfig: api.pluginConfig }));
    api.registerProvider(buildCodexProvider({ pluginConfig: api.pluginConfig }));
    api.registerMediaUnderstandingProvider(
      buildCodexMediaUnderstandingProvider({ pluginConfig: api.pluginConfig }),
    );
    api.registerMigrationProvider(buildCodexMigrationProvider());
    api.registerCommand(createCodexCommand({ pluginConfig: api.pluginConfig }));
    api.on("inbound_claim", (event, ctx) =>
      handleCodexConversationInboundClaim(event, ctx, {
        pluginConfig: resolveCurrentPluginConfig(),
      }),
    );
    api.onConversationBindingResolved?.(handleCodexConversationBindingResolved);
  },
});
