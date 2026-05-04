/**
 * Plugin Command Handler
 *
 * Handles commands registered by plugins, bypassing the LLM agent.
 * This handler is called before built-in command handlers.
 */

import { matchPluginCommand, executePluginCommand } from "../../plugins/commands.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

/**
 * Handle plugin-registered commands.
 * Returns a result if a plugin command was matched and executed,
 * or null to continue to the next handler.
 */
export const handlePluginCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  const { command, cfg } = params;
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  if (!allowTextCommands) {
    return null;
  }

  // Try to match a plugin command
  const match = matchPluginCommand(command.commandBodyNormalized, { channel: command.channel });
  if (!match) {
    return null;
  }

  // Execute the plugin command (always returns a result)
  const result = await executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: command.senderId,
    channel: command.channel,
    channelId: command.channelId,
    isAuthorizedSender: command.isAuthorizedSender,
    senderIsOwner: command.senderIsOwner,
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
    sessionFile: targetSessionEntry?.sessionFile,
    commandBody: command.commandBodyNormalized,
    config: cfg,
    from: command.from,
    to: command.to,
    accountId: params.ctx.AccountId ?? undefined,
    messageThreadId:
      typeof params.ctx.MessageThreadId === "string" ||
      typeof params.ctx.MessageThreadId === "number"
        ? params.ctx.MessageThreadId
        : undefined,
    threadParentId: normalizeOptionalString(params.ctx.ThreadParentId),
  });
  const shouldContinue = result.continueAgent === true;
  const { continueAgent: _continueAgent, ...reply } = result;
  void _continueAgent;

  return {
    shouldContinue,
    reply: Object.keys(reply).length > 0 ? reply : undefined,
  };
};
