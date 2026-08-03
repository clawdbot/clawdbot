/**
 * Slash command handler — intercept slash commands before message queue.
 *
 * Extracted from gateway.ts to keep the gateway connection logic thin.
 * Handles urgent commands, normal slash commands, and file delivery.
 */

import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveGroupCommandLevelFromAccountConfig } from "../config/group.js";
import type { QQBotIngressEffectOnce } from "../gateway/ingress-effects.js";
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
  resolveCommandAuthorized?: (params: {
    isGroup: boolean;
    senderId: string;
    conversationId: string;
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    commandsAllowFrom?: Array<string | number>;
  }) => boolean | Promise<boolean>;
}

// ============ Constants ============

const URGENT_COMMANDS = ["/stop"];

class SlashCommandIngressEffectError extends Error {
  constructor(readonly effectCause: unknown) {
    super("QQBot slash-command ingress effect failed");
    this.name = "SlashCommandIngressEffectError";
  }
}

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
  ingress?: { eventId: string; effectOnce: QQBotIngressEffectOnce },
): Promise<"handled" | "urgent" | "enqueue"> {
  const { account, log } = ctx;
  const content = (msg.content ?? "").trim();

  if (!content.startsWith("/")) {
    return "enqueue";
  }

  const isGroup = msg.type === "group" || msg.type === "guild";
  const groupCommandLevel = isGroup
    ? resolveGroupCommandLevelFromAccountConfig(
        account.config,
        msg.groupOpenid ?? msg.channelId ?? null,
      )
    : undefined;
  const commandsAllowFrom = resolveQQBotCommandsAllowFrom(ctx.cfg);
  const commandAuthorized = ctx.resolveCommandAuthorized
    ? await ctx.resolveCommandAuthorized({
        isGroup,
        senderId: msg.senderId,
        conversationId: msg.groupOpenid ?? msg.channelId ?? msg.senderId,
        allowFrom: account.config?.allowFrom,
        groupAllowFrom: account.config?.groupAllowFrom,
        commandsAllowFrom,
      })
    : resolveSlashCommandAuth({
        senderId: msg.senderId,
        isGroup,
        allowFrom: account.config?.allowFrom,
        groupAllowFrom: account.config?.groupAllowFrom,
        commandsAllowFrom,
      });

  // Urgent command detection — bypass queue and execute immediately.
  const contentLower = content.toLowerCase();
  const isUrgentCommand = URGENT_COMMANDS.some(
    (cmd) => contentLower === cmd.toLowerCase() || contentLower.startsWith(cmd.toLowerCase() + " "),
  );
  if (isUrgentCommand) {
    if (isGroup && !commandAuthorized) {
      return "enqueue";
    }
    log?.info(`Urgent command detected: ${truncateUtf16Safe(content, 20)}`);
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
    commandAuthorized,
    groupCommandLevel,
    queueSnapshot: ctx.getQueueSnapshot(peerId),
    ...(ingress
      ? {
          runIngressEffectOnce: async <T>(params: { effect: string; run: () => Promise<T> }) => {
            try {
              return await ingress.effectOnce.runOnce({ eventId: ingress.eventId, ...params });
            } catch (error) {
              throw new SlashCommandIngressEffectError(error);
            }
          },
        }
      : {}),
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
    if (err instanceof SlashCommandIngressEffectError) {
      throw err.effectCause;
    }
    log?.error(`Slash command error: ${String(err)}`);
    return "enqueue";
  }
}
