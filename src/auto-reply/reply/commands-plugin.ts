/**
 * Plugin Command Handler
 *
 * Handles commands registered by plugins, bypassing the LLM agent.
 * This handler is called before built-in command handlers.
 */

import { matchPluginCommand, executePluginCommand } from "../../plugins/commands.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

/**
 * Handle plugin-registered commands.
 * Returns a result if a plugin command was matched and executed,
 * or null to continue to the next handler.
 */
export const handlePluginCommand: CommandHandler = async (
  params,
  _allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  const { command, cfg } = params;

  // Try to match a plugin command
  const match = matchPluginCommand(command.commandBodyNormalized);
  if (!match) return null;

  // Execute the plugin command (always returns a result)
  const result = await executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: command.senderId,
    channel: command.channel,
    isAuthorizedSender: command.isAuthorizedSender,
    commandBody: command.commandBodyNormalized,
    config: cfg,
  });

  return {
    shouldContinue: false,
    reply: { text: result.text },
  };
};
