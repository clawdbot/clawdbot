/**
 * QQBot plugin-level slash command handler.
 *
 * Type definitions and the command registry/dispatcher are in
 * `./slash-commands.ts`. Built-in command bodies live under `./builtin/`.
 */

import type { CommandsPort } from "../adapter/commands.port.js";
import { debugLog } from "../utils/log.js";
import { registerBuiltinSlashCommands } from "./builtin/register-all.js";
import {
  getFrameworkVersionString,
  getPluginVersionString,
  initSlashCommandDeps,
} from "./builtin/state.js";
import {
  SlashCommandRegistry,
  type SlashCommandContext,
  type SlashCommandResult,
  type QQBotFrameworkCommand,
} from "./slash-commands.js";

const registry = new SlashCommandRegistry();
registerBuiltinSlashCommands(registry);

/**
 * Initialize command dependencies from the EngineAdapters.commands port.
 * Called once by the bridge layer during startup.
 */
export function initCommands(port: CommandsPort): void {
  initSlashCommandDeps(port);
}

export type {
  SlashCommandContext,
  SlashCommandResult,
  SlashCommandFileResult,
  QQBotFrameworkCommand,
  QueueSnapshot,
} from "./slash-commands.js";

/**
 * Return all commands that require authorization, for registration with the
 * framework via api.registerCommand() in registerFull().
 */
export function getFrameworkCommands(): QQBotFrameworkCommand[] {
  return registry.getFrameworkCommands();
}

// Slash command entry point — delegates to core/ registry.

/**
 * Try to match and execute a plugin-level slash command.
 *
 * @returns A reply when matched, or null when the message should continue through normal routing.
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  return registry.matchSlashCommand(ctx, { info: debugLog });
}

/** Return the plugin version for external callers. */
export function getPluginVersion(): string {
  return getPluginVersionString();
}

/** Return the framework version for external callers. */
export function getFrameworkVersion(): string {
  return getFrameworkVersionString();
}
