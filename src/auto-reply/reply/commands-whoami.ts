/** Handles /whoami identity reporting for authorized command senders. */
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

/** Command handler for the /whoami identity diagnostic. */
export const handleWhoamiCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/whoami",
    match: (body) => (body === "/whoami" ? true : null),
    silentUnauthorized: true,
  },
  (params) => {
    const senderId = params.ctx.SenderId ?? "";
    const senderUsername = params.ctx.SenderUsername ?? "";
    const lines = ["🧭 Identity", `Channel: ${params.command.channel}`];
    if (senderId) {
      lines.push(`User id: ${senderId}`);
    }
    if (senderUsername) {
      const handle = senderUsername.startsWith("@") ? senderUsername : `@${senderUsername}`;
      lines.push(`Username: ${handle}`);
    }
    if (params.ctx.ChatType === "group" && params.ctx.From) {
      lines.push(`Chat: ${params.ctx.From}`);
    }
    if (params.ctx.MessageThreadId != null) {
      lines.push(`Thread: ${params.ctx.MessageThreadId}`);
    }
    const allowFromSender = params.command.senderId ?? "";
    if (allowFromSender) {
      lines.push(`AllowFrom: ${allowFromSender}`);
    }
    return commandReply(lines.join("\n"));
  },
);
