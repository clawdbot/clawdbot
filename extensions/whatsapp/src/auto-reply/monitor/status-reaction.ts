// Whatsapp plugin module implements status reaction behavior.
import {
  createStatusReactionController,
  shouldAckReactionForWhatsApp,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { resolveWhatsAppReactionLevel } from "../../reaction-level.js";
import { sendReactionWhatsApp } from "../../send.js";
import { resolveWhatsAppAckEmoji } from "./ack-emoji.js";
import { resolveGroupActivationFor } from "./group-activation.js";
import { resolveReactionParticipant } from "./reaction-participant.js";

export type { StatusReactionController };

type WhatsAppStatusReactionParams = {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  agentId: string;
  sessionKey: string;
  verbose: boolean;
};

export async function createWhatsAppStatusReactionController(
  params: WhatsAppStatusReactionParams,
): Promise<StatusReactionController | null> {
  if (!params.msg.event.id) {
    return null;
  }

  const statusReactionsConfig = params.cfg.messages?.statusReactions;
  if (statusReactionsConfig?.enabled !== true) {
    return null;
  }

  const admission = requireWhatsAppInboundAdmission(params.msg);
  const accountId = admission.accountId;
  const reactionLevel = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId,
  });
  if (reactionLevel.level === "off") {
    return null;
  }

  const ackConfig = params.cfg.messages?.ackReaction;
  const scope = params.cfg.messages?.ackReactionScope ?? "group-mentions";
  if (scope === "off" || scope === "none") {
    return null;
  }
  const ackEmoji = resolveWhatsAppAckEmoji({
    cfg: params.cfg,
    agentId: params.agentId,
    ackConfig,
  });
  if (!ackEmoji) {
    return null;
  }
  const directEnabled = scope === "all" || scope === "direct";
  const groupMode =
    scope === "all" || scope === "group-all" ? "always" : scope === "direct" ? "never" : "mentions";
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

  const shouldUseStatusReaction = shouldAckReactionForWhatsApp({
    emoji: ackEmoji,
    isDirect: admission.conversation.kind === "direct",
    isGroup,
    directEnabled,
    groupMode,
    wasMentioned: (params.msg.groupMention?.wasMentioned ?? params.msg.wasMentioned) === true,
    groupActivated: activation === "always",
  });

  if (!shouldUseStatusReaction) {
    return null;
  }

  const participant = resolveReactionParticipant(params.msg);
  const reactionOptions = {
    verbose: params.verbose,
    fromMe: false,
    ...(participant ? { participant } : {}),
    accountId,
    cfg: params.cfg,
  };
  const chatId = params.msg.platform.chatJid;
  const msgId = params.msg.event.id;

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
    emojis: undefined,
    onError: (err) => {
      logVerbose(`WhatsApp status-reaction error for chat ${chatId}/${msgId}: ${String(err)}`);
    },
  });
}
