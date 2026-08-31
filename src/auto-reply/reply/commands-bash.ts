// Implements bash command execution, approval, and stop handling.
import { handleBashChatCommand } from "./bash-command.js";
import { defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleBashCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/bash",
    match: (body, params) =>
      matchCommandPrefix(body, "/bash") !== null ||
      (body.startsWith("!") && params.command.isAuthorizedSender)
        ? true
        : null,
  },
  async (params) => {
    const reply = await handleBashChatCommand({
      ctx: params.ctx,
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      isGroup: params.isGroup,
      elevated: params.elevated,
    });
    return { shouldContinue: false, reply };
  },
);
