/**
 * Slash command handler — intercept slash commands before message queue.
 *
 * Extracted from gateway.ts to keep the gateway connection logic thin.
 * Handles urgent commands, normal slash commands, and file delivery.
 */

import type { QueuedMessage } from "../gateway/message-queue.js";
import type { GatewayAccount, EngineLogger } from "../gateway/types.js";
import { sendDocument } from "../messaging/outbound.js";
import {
  sendText as senderSendText,
  buildDeliveryTarget,
  accountToCreds,
} from "../messaging/sender.js";
import { resolveQQBotCommandsAllowFrom, resolveSlashCommandAuth } from "./slash-command-auth.js";
import { matchSlashCommand } from "./slash-commands-impl.js";
import type { SlashCommandContext, QueueSnapshot } from "./slash-commands.js";

// ============ Types ============

export interface SlashCommandHandlerContext {
  account: GatewayAccount;
  cfg?: unknown;
  log?: EngineLogger;
  getMessagePeerId: (msg: QueuedMessage) => string;
  getQueueSnapshot: (peerId: string) => QueueSnapshot;
}

// ============ Constants ============

const URGENT_COMMANDS = ["/stop"];

// ============ trySlashCommandOrEnqueue ============

/**
 * Check if the message is a slash command and handle it.
 *
 * @returns `true` if handled (command executed or enqueued as urgent),
 *          `false` if the message should be queued for normal processing.
 */
export async function trySlashCommand(
  msg: QueuedMessage,
  ctx: SlashCommandHandlerContext,
): Promise<"handled" | "urgent" | "enqueue"> {
  const { account, log } = ctx;
  const content = (msg.content ?? "").trim();

  if (!content.startsWith("/")) {
    return "enqueue";
  }

  // Urgent command detection — bypass queue and execute immediately.
  const contentLower = content.toLowerCase();
  const isUrgentCommand = URGENT_COMMANDS.some(
    (cmd) => contentLower === cmd.toLowerCase() || contentLower.startsWith(cmd.toLowerCase() + " "),
  );
  if (isUrgentCommand) {
    log?.info(`Urgent command detected: ${content.slice(0, 20)}`);
    return "urgent";
  }

  // Normal slash command — try to match and execute.
  const receivedAt = Date.now();
  const peerId = ctx.getMessagePeerId(msg);
  const cmdCtx: SlashCommandContext = {
    type: msg.type,
    senderId: msg.senderId,
    senderName: msg.senderName,
    messageId: msg.messageId,
    eventTimestamp: msg.timestamp,
    receivedAt,
    rawContent: content,
    args: "",
    channelId: msg.channelId,
    groupOpenid: msg.groupOpenid,
    accountId: account.accountId,
    appId: account.appId,
    accountConfig: account.config,
    commandAuthorized: resolveSlashCommandAuth({
      senderId: msg.senderId,
      isGroup: msg.type === "group" || msg.type === "guild",
      allowFrom: account.config?.allowFrom,
      groupAllowFrom: account.config?.groupAllowFrom,
      commandsAllowFrom: resolveQQBotCommandsAllowFrom(ctx.cfg),
    }),
    queueSnapshot: ctx.getQueueSnapshot(peerId),
  };

  try {
    const reply = await matchSlashCommand(cmdCtx);
    if (reply === null) {
      return "enqueue";
    }

    log?.debug?.(`Slash command matched: ${content}`);

    const isFileResult = typeof reply === "object" && reply !== null && "filePath" in reply;
    const replyText = isFileResult ? (reply as { text: string }).text : reply;
    const replyFile = isFileResult ? (reply as { filePath: string }).filePath : null;

    // Send text reply.
    if (msg.type === "c2c" || msg.type === "group" || msg.type === "dm" || msg.type === "guild") {
      const slashTarget = buildDeliveryTarget(msg);
      const slashCreds = accountToCreds(account);
      await senderSendText(slashTarget, replyText, slashCreds, { msgId: msg.messageId });
    }

    // Send file attachment if present.
    if (replyFile) {
      try {
        const targetType =
          msg.type === "group"
            ? "group"
            : msg.type === "dm"
              ? "dm"
              : msg.type === "c2c"
                ? "c2c"
                : "channel";
        const targetId =
          msg.type === "group"
            ? msg.groupOpenid || msg.senderId
            : msg.type === "dm"
              ? msg.guildId || msg.senderId
              : msg.type === "c2c"
                ? msg.senderId
                : msg.channelId || msg.senderId;
        await sendDocument(
          {
            targetType,
            targetId,
            account,
            replyToId: msg.messageId,
          },
          replyFile,
          { allowQQBotDataDownloads: true },
        );
      } catch (fileErr) {
        log?.error(`Failed to send slash command file: ${String(fileErr)}`);
      }
    }

    return "handled";
  } catch (err) {
    log?.error(`Slash command error: ${String(err)}`);
    return "enqueue";
  }
}
