import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

export const handleWhoamiCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/whoami") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /whoami from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
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
  return { shouldContinue: false, reply: { text: lines.join("\n") } };
};
