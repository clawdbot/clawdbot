// Whatsapp plugin module implements ack reaction behavior.
import {
  createAckReactionHandle,
  shouldAckReactionForWhatsApp,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { resolveWhatsAppReactionLevel } from "../../reaction-level.js";
import { sendReactionWhatsApp } from "../../send.js";
import { formatError } from "../../session.js";
import { resolveWhatsAppAckEmoji } from "./ack-emoji.js";
import { resolveGroupActivationFor } from "./group-activation.js";
import { resolveReactionParticipant } from "./reaction-participant.js";

export async function maybeSendAckReaction(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  agentId: string;
  sessionKey: string;
  verbose: boolean;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}): Promise<AckReactionHandle | null> {
  if (!params.msg.event.id) {
    return null;
  }

  const admission = requireWhatsAppInboundAdmission(params.msg);
  const accountId = admission.accountId;
  // Keep ackReaction as the emoji/scope control, while letting reactionLevel
  // suppress all automatic reactions when it is explicitly set to "off".
  const reactionLevel = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId,
  });
  if (reactionLevel.level === "off") {
    return null;
  }

  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  const emoji = resolveWhatsAppAckEmoji({
    cfg: params.cfg,
    agentId: params.agentId,
    ackConfig,
  });
  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "mentions";
  const isGroup = admission.conversation.kind === "group";
  const conversationIdForCheck = admission.conversation.id;

  const activation = isGroup
    ? await resolveGroupActivationFor({
        cfg: params.cfg,
        accountId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        conversationId: conversationIdForCheck,
      })
    : null;
  const shouldSendReaction = () =>
    shouldAckReactionForWhatsApp({
      emoji,
      isDirect: admission.conversation.kind === "direct",
      isGroup,
      directEnabled,
      groupMode,
      wasMentioned: (params.msg.groupMention?.wasMentioned ?? params.msg.wasMentioned) === true,
      groupActivated: activation === "always",
    });

  if (!shouldSendReaction()) {
    return null;
  }

  params.info(
    { chatId: params.msg.platform.chatJid, messageId: params.msg.event.id, emoji },
    "sending ack reaction",
  );
  const participant = resolveReactionParticipant(params.msg);
  const reactionOptions = {
    verbose: params.verbose,
    fromMe: false,
    ...(participant ? { participant } : {}),
    accountId,
    cfg: params.cfg,
  };
  return createAckReactionHandle({
    ackReactionValue: emoji,
    send: () =>
      sendReactionWhatsApp(
        params.msg.platform.chatJid,
        params.msg.event.id!,
        emoji,
        reactionOptions,
      ),
    remove: () =>
      sendReactionWhatsApp(params.msg.platform.chatJid, params.msg.event.id!, "", reactionOptions),
    onSendError: (err) => {
      params.warn(
        {
          error: formatError(err),
          chatId: params.msg.platform.chatJid,
          messageId: params.msg.event.id,
        },
        "failed to send ack reaction",
      );
      logVerbose(
        `WhatsApp ack reaction failed for chat ${params.msg.platform.chatJid}: ${formatError(err)}`,
      );
    },
  });
}
