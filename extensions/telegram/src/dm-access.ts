import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  createTelegramIngressSubject,
  createTelegramIngressResolver,
  telegramAllowEntries,
} from "./ingress.js";

type TelegramDmAccessLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};

type TelegramSenderIdentity = {
  username: string;
  userId: string | null;
  candidateId: string;
  firstName?: string;
  lastName?: string;
};

function resolveTelegramSenderIdentity(msg: Message, chatId: number): TelegramSenderIdentity {
  const from = msg.from;
  const userId = from?.id != null ? String(from.id) : null;
  return {
    username: from?.username ?? "",
    userId,
    candidateId: userId ?? String(chatId),
    firstName: from?.first_name,
    lastName: from?.last_name,
  };
}

async function decideTelegramDmAccess(params: {
  accountId: string;
  dmPolicy: DmPolicy;
  sender: TelegramSenderIdentity;
  effectiveDmAllow: NormalizedAllowFrom;
}) {
  const result = await createTelegramIngressResolver({ accountId: params.accountId }).message({
    subject: createTelegramIngressSubject(params.sender.candidateId),
    conversation: {
      kind: "direct",
      id: params.sender.candidateId,
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: "disabled",
    allowFrom: telegramAllowEntries(params.effectiveDmAllow),
  });
  return result.ingress;
}

export async function enforceTelegramDmAccess(params: {
  isGroup: boolean;
  dmPolicy: DmPolicy;
  msg: Message;
  chatId: number;
  effectiveDmAllow: NormalizedAllowFrom;
  accountId: string;
  bot: Bot;
  logger: TelegramDmAccessLogger;
  upsertPairingRequest?: typeof upsertChannelPairingRequest;
}): Promise<boolean> {
  const {
    isGroup,
    dmPolicy,
    msg,
    chatId,
    effectiveDmAllow,
    accountId,
    bot,
    logger,
    upsertPairingRequest,
  } = params;
  if (isGroup) {
    return true;
  }
  if (dmPolicy === "disabled") {
    return false;
  }

  const sender = resolveTelegramSenderIdentity(msg, chatId);
  const access = await decideTelegramDmAccess({
    accountId,
    dmPolicy,
    sender,
    effectiveDmAllow,
  });
  if (access.decision === "allow") {
    return true;
  }

  if (dmPolicy === "open") {
    logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=open)`);
    return false;
  }

  if (access.decision === "pairing") {
    try {
      const telegramUserId = sender.userId ?? sender.candidateId;
      await createChannelPairingChallengeIssuer({
        channel: "telegram",
        upsertPairingRequest: async ({ id, meta }) =>
          await (upsertPairingRequest ?? upsertChannelPairingRequest)({
            channel: "telegram",
            id,
            accountId,
            meta,
          }),
      })({
        senderId: telegramUserId,
        senderIdLine: `Your Telegram user id: ${telegramUserId}`,
        meta: {
          username: sender.username || undefined,
          firstName: sender.firstName,
          lastName: sender.lastName,
        },
        onCreated: () => {
          logger.info(
            {
              chatId: String(chatId),
              senderUserId: sender.userId ?? undefined,
              username: sender.username || undefined,
              firstName: sender.firstName,
              lastName: sender.lastName,
            },
            "telegram pairing request",
          );
        },
        sendPairingReply: async (text) => {
          const html = renderTelegramHtmlText(text);
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            fn: () => bot.api.sendMessage(chatId, html, { parse_mode: "HTML" }),
          });
        },
        onReplyError: (err) => {
          logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
        },
      });
    } catch (err) {
      logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
    }
    return false;
  }

  logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy})`);
  return false;
}
