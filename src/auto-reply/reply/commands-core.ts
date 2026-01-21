import { logVerbose } from "../../globals.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { routeReply } from "./route-reply.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import {
  handleCommandsListCommand,
  handleContextCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleWhoamiCommand,
} from "./commands-info.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleModelsCommand } from "./commands-models.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleRestartCommand,
  handleSendPolicyCommand,
  handleStopCommand,
  handleUsageCommand,
} from "./commands-session.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

const HANDLERS: CommandHandler[] = [
  handleBashCommand,
  handleActivationCommand,
  handleSendPolicyCommand,
  handleUsageCommand,
  handleRestartCommand,
  handleHelpCommand,
  handleCommandsListCommand,
  handleStatusCommand,
  handleAllowlistCommand,
  handleContextCommand,
  handleWhoamiCommand,
  handleSubagentsCommand,
  handleConfigCommand,
  handleDebugCommand,
  handleModelsCommand,
  handleStopCommand,
  handleCompactCommand,
  handleAbortTrigger,
];

export async function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult> {
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
  const resetRequested = Boolean(resetMatch);
  if (resetRequested && !params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Trigger internal hook for reset/new commands
  if (resetRequested && params.command.isAuthorizedSender) {
    const commandAction = resetMatch?.[1] ?? "new";
    const hookEvent = createInternalHookEvent("command", commandAction, params.sessionKey ?? "", {
      sessionEntry: params.sessionEntry,
      previousSessionEntry: params.previousSessionEntry,
      commandSource: params.command.surface,
      senderId: params.command.senderId,
      cfg: params.cfg, // Pass config for LLM slug generation
    });
    await triggerInternalHook(hookEvent);

    // Send hook messages immediately if present
    if (hookEvent.messages.length > 0) {
      // Use OriginatingChannel/To if available, otherwise fall back to command channel/from
      const channel = params.ctx.OriginatingChannel || (params.command.channel as any);
      // For replies, use 'from' (the sender) not 'to' (which might be the bot itself)
      const to = params.ctx.OriginatingTo || params.command.from || params.command.to;

      if (channel && to) {
        const hookReply = { text: hookEvent.messages.join("\n\n") };
        await routeReply({
          payload: hookReply,
          channel: channel,
          to: to,
          sessionKey: params.sessionKey,
          accountId: params.ctx.AccountId,
          threadId: params.ctx.MessageThreadId,
          cfg: params.cfg,
        });
      }
    }
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: params.command.surface,
    commandSource: params.ctx.CommandSource,
  });

  for (const handler of HANDLERS) {
    const result = await handler(params, allowTextCommands);
    if (result) return result;
  }

  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
    channel: params.sessionEntry?.channel ?? params.command.channel,
    chatType: params.sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${params.sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }

  return { shouldContinue: true };
}
