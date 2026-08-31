// Implements maintenance commands for OpenClaw-backed session cleanup.
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

export const handleSystemAgentCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const { extractSystemAgentRescueMessage, runSystemAgentRescueMessage } =
    await import("../../system-agent/rescue-message.js");
  if (extractSystemAgentRescueMessage(params.command.commandBodyNormalized) === null) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /openclaw from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  return {
    shouldContinue: false,
    reply: {
      text:
        (await runSystemAgentRescueMessage({
          cfg: params.cfg,
          command: params.command,
          commandBody: params.command.commandBodyNormalized,
          agentId: params.agentId,
          isGroup: params.isGroup,
        })) ?? "OpenClaw did not find a rescue request.",
    },
  };
};
