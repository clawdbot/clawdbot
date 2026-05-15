import {
  createStatusReactionController,
  shouldAckReactionForWhatsApp,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSenderIdentity } from "../../identity.js";
import { resolveWhatsAppReactionLevel } from "../../reaction-level.js";
import { sendReactionWhatsApp } from "../../send.js";
import type { WebInboundMsg } from "../types.js";
import { resolveGroupActivationFor } from "./group-activation.js";

export type { StatusReactionController };

export type WhatsAppStatusReactionParams = {
  cfg: OpenClawConfig;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  verbose: boolean;
  accountId?: string;
};

export async function createWhatsAppStatusReactionController(
  params: WhatsAppStatusReactionParams,
): Promise<StatusReactionController | null> {
  if (!params.msg.id) {
    return null;
  }

  const statusReactionsConfig = params.cfg.messages?.statusReactions;
  if (statusReactionsConfig?.enabled !== true) {
    return null;
  }

  const reactionLevel = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (reactionLevel.level === "off") {
    return null;
  }

  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  const ackEmoji = (ackConfig?.emoji ?? "").trim();
  if (!ackEmoji) {
    return null;
  }
  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "mentions";
  const conversationIdForCheck = params.msg.conversationId ?? params.msg.from;

  const activation =
    params.msg.chatType === "group"
      ? await resolveGroupActivationFor({
          cfg: params.cfg,
          accountId: params.accountId,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          conversationId: conversationIdForCheck,
        })
      : null;

  const shouldUseStatusReaction = shouldAckReactionForWhatsApp({
    emoji: ackEmoji,
    isDirect: params.msg.chatType === "direct",
    isGroup: params.msg.chatType === "group",
    directEnabled,
    groupMode,
    wasMentioned: params.msg.wasMentioned === true,
    groupActivated: activation === "always",
  });

  if (!shouldUseStatusReaction) {
    return null;
  }

  const sender = getSenderIdentity(params.msg);
  const reactionOptions = {
    verbose: params.verbose,
    fromMe: false,
    ...(sender.jid ? { participant: sender.jid } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    cfg: params.cfg,
  };
  const chatId = params.msg.chatId;
  const msgId = params.msg.id;

  return createStatusReactionController({
    enabled: true,
    adapter: {
      setReaction: async (emoji: string) => {
        await sendReactionWhatsApp(chatId, msgId, emoji, reactionOptions);
      },
      clearReaction: async () => {
        await sendReactionWhatsApp(chatId, msgId, "", reactionOptions);
      },
    },
    initialEmoji: ackEmoji,
    emojis: statusReactionsConfig.emojis,
    timing: statusReactionsConfig.timing,
    onError: (err) => {
      logVerbose(`WhatsApp status-reaction error for chat ${chatId}/${msgId}: ${String(err)}`);
    },
  });
}
