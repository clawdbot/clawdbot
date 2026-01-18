import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import {
  createMemoryGetTool,
  createMemorySearchTool,
  registerMemoryCli,
} from "clawdbot/plugin-sdk";

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  register(api: ClawdbotPluginApi) {
    api.registerTool(
      (ctx) => {
        const memorySearchTool = createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) return null;
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    api.registerCli(
      ({ program }) => {
        registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
};

export default memoryCorePlugin;
