import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { CodexCommandDeps } from "./command-handlers.js";

export function createCodexCommand(options: {
  pluginConfig?: unknown;
  deps?: Partial<CodexCommandDeps>;
}): OpenClawPluginCommandDefinition {
  return {
    name: "codex",
    description: "Inspect and control the Codex app-server harness",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCodexCommand(ctx, options),
  };
}

export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> } = {},
): Promise<{ text: string }> {
  const { handleCodexSubcommand } = await import("./command-handlers.js");
  return await handleCodexSubcommand(ctx, options);
}
