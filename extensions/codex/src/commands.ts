import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { CodexCommandDeps } from "./command-handlers.js";

export function createCodexCommand(options: {
  pluginConfig?: unknown;
  deps?: Partial<CodexCommandDeps>;
}): OpenClawPluginCommandDefinition {
  return {
    name: "codex",
    description: "Inspect and control the Codex app-server harness",
    ownership: "reserved",
    agentPromptGuidance: [
      "Native Codex app-server plugin is available (`/codex ...`). For Codex bind/control/thread/resume/steer/stop requests, prefer `/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`, and `/codex stop` over ACP.",
      "Use ACP for Codex only when the user explicitly asks for ACP/acpx or wants to test the ACP path.",
    ],
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCodexCommand(ctx, options),
  };
}

export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> } = {},
): Promise<PluginCommandResult> {
  const { handleCodexSubcommand } = await import("./command-handlers.js");
  return await handleCodexSubcommand(ctx, options);
}
