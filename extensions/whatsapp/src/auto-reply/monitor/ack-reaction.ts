import {
  createAckReactionHandle,
  shouldAckReactionForWhatsApp,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSenderIdentity } from "../../identity.js";
import { resolveWhatsAppReactionLevel } from "../../reaction-level.js";
import { sendReactionWhatsApp } from "../../send.js";
import { formatError } from "../../session.js";
import type { WebInboundMsg } from "../types.js";
import { resolveGroupActivationFor } from "./group-activation.js";

export async function maybeSendAckReaction(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  verbose: boolean;
  accountId?: string;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}): Promise<AckReactionHandle | null> {
  if (!params.msg.id) {
    return null;
  }

  // Keep ackReaction as the emoji/scope control, while letting reactionLevel
  // suppress all automatic reactions when it is explicitly set to "off".
  const reactionLevel = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (reactionLevel.level === "off") {
    return null;
  }

  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  const emoji = (ackConfig?.emoji ?? "").trim();
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
  const shouldSendReaction = () =>
    shouldAckReactionForWhatsApp({
      emoji,
      isDirect: params.msg.chatType === "direct",
      isGroup: params.msg.chatType === "group",
      directEnabled,
      groupMode,
      wasMentioned: params.msg.wasMentioned === true,
      groupActivated: activation === "always",
    });

  if (!shouldSendReaction()) {
    return null;
  }

  params.info(
    { chatId: params.msg.chatId, messageId: params.msg.id, emoji },
    "sending ack reaction",
  );
  const sender = getSenderIdentity(params.msg);
  const reactionOptions = {
    verbose: params.verbose,
    fromMe: false,
    ...(sender.jid ? { participant: sender.jid } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    cfg: params.cfg,
  };
  return createAckReactionHandle({
    ackReactionValue: emoji,
    send: () => sendReactionWhatsApp(params.msg.chatId, params.msg.id!, emoji, reactionOptions),
    remove: () => sendReactionWhatsApp(params.msg.chatId, params.msg.id!, "", reactionOptions),
    onSendError: (err) => {
      params.warn(
        {
          error: formatError(err),
          chatId: params.msg.chatId,
          messageId: params.msg.id,
        },
        "failed to send ack reaction",
      );
      logVerbose(`WhatsApp ack reaction failed for chat ${params.msg.chatId}: ${formatError(err)}`);
    },
  });
}
