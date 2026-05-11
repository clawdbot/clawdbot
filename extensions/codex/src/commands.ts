import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { describeControlFailure } from "./app-server/capabilities.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import type { CodexCommandDeps } from "./command-handlers.js";

type CodexCommandOptions = {
  pluginConfig?: unknown;
  deps?: Partial<CodexCommandDeps>;
};

type CodexSubcommandHandler = (
  ctx: PluginCommandContext,
  options: CodexCommandOptions,
) => Promise<PluginCommandResult>;

type CodexCommandInternalOptions = CodexCommandOptions & {
  loadSubcommandHandler?: () => Promise<CodexSubcommandHandler>;
};

export function createCodexCommand(options: CodexCommandOptions): OpenClawPluginCommandDefinition {
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
  options: CodexCommandInternalOptions = {},
): Promise<PluginCommandResult> {
  const { loadSubcommandHandler, ...subcommandOptions } = options;
  try {
    const handleCodexSubcommand = loadSubcommandHandler
      ? await loadSubcommandHandler()
      : await loadDefaultCodexSubcommandHandler();
    return await handleCodexSubcommand(ctx, subcommandOptions);
  } catch (error) {
    return {
      text: `Codex command failed: ${formatCodexDisplayText(describeControlFailure(error))}`,
    };
  }
}

async function loadDefaultCodexSubcommandHandler(): Promise<CodexSubcommandHandler> {
  const { handleCodexSubcommand } = await import("./command-handlers.js");
  return handleCodexSubcommand;
}
