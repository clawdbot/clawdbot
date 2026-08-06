import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { describeControlFailure } from "./app-server/capabilities.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import type { CodexCommandDepsOverride } from "./command-handlers.js";

type CodexCommandOptions = {
  pluginConfig?: unknown;
  resolvePluginConfig?: () => unknown;
  deps: CodexCommandDepsOverride;
};

type CodexSubcommandHandler = (
  ctx: PluginCommandContext,
  options: CodexCommandOptions,
) => Promise<PluginCommandResult>;

type CodexCommandInternalOptions = CodexCommandOptions & {
  loadSubcommandHandler?: () => Promise<CodexSubcommandHandler>;
};

/** Dispatches a `/codex` command to the lazily loaded handler. */
export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: CodexCommandInternalOptions,
): Promise<PluginCommandResult> {
  const { loadSubcommandHandler, resolvePluginConfig, ...subcommandOptions } = options;
  try {
    const handleCodexSubcommand = loadSubcommandHandler
      ? await loadSubcommandHandler()
      : await loadDefaultCodexSubcommandHandler();
    return await handleCodexSubcommand(ctx, {
      ...subcommandOptions,
      pluginConfig: resolvePluginConfig?.() ?? subcommandOptions.pluginConfig,
    });
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
