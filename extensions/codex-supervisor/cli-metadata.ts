// Codex Supervisor CLI metadata stays lightweight until the command runs.
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export function registerCodexSupervisorCliMetadata(api: OpenClawPluginApi): void {
  api.registerCli(
    async ({ program }) => {
      const { registerCodexSupervisorCli } = await import("./src/cli.js");
      registerCodexSupervisorCli(program);
    },
    {
      descriptors: [
        {
          name: "codex",
          description: "Inspect Codex sessions across the Gateway and paired nodes",
          hasSubcommands: true,
        },
      ],
    },
  );
}

export default definePluginEntry({
  id: "codex-supervisor",
  name: "Codex Supervisor",
  description: "Supervise Codex app-server sessions from OpenClaw.",
  register: registerCodexSupervisorCliMetadata,
});
