import { shouldAckReactionForWhatsApp } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { resolveWhatsAppReactionLevel } from "../../reaction-level.js";
import type { sendReactionWhatsApp } from "../../send.js";
import { resolveWhatsAppAckEmoji } from "./ack-emoji.js";
import { resolveGroupActivationFor } from "./group-activation.js";
import { resolveReactionParticipant } from "./reaction-participant.js";

const DISABLED_REACTION = { status: "disabled" } as const;

export async function resolveWhatsAppReactionEligibility(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  agentId: string;
  sessionKey: string;
  verbose: boolean;
}) {
  const messageId = params.msg.event.id;
  if (!messageId) {
    return DISABLED_REACTION;
  }

  const admission = requireWhatsAppInboundAdmission(params.msg);
  const accountId = admission.accountId;
  // ackReaction owns emoji/scope, while reactionLevel can suppress every automatic reaction.
  if (resolveWhatsAppReactionLevel({ cfg: params.cfg, accountId }).level === "off") {
    return DISABLED_REACTION;
  }

  const scope = params.cfg.messages?.ackReactionScope ?? "group-mentions";
  if (scope === "off" || scope === "none") {
    return DISABLED_REACTION;
  }
  const emoji = resolveWhatsAppAckEmoji({
    cfg: params.cfg,
    agentId: params.agentId,
    ackConfig: params.cfg.messages?.ackReaction,
  });
  const directEnabled = scope === "all" || scope === "direct";
  const groupMode =
    scope === "all" || scope === "group-all" ? "always" : scope === "direct" ? "never" : "mentions";
  const isGroup = admission.conversation.kind === "group";
  const activation = isGroup
    ? await resolveGroupActivationFor({
        cfg: params.cfg,
        accountId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        conversationId: admission.conversation.id,
      })
    : null;
  if (
    !shouldAckReactionForWhatsApp({
      emoji,
      isDirect: admission.conversation.kind === "direct",
      isGroup,
      directEnabled,
      groupMode,
      wasMentioned: (params.msg.groupMention?.wasMentioned ?? params.msg.wasMentioned) === true,
      groupActivated: activation === "always",
    })
  ) {
    return DISABLED_REACTION;
  }

  const participant = resolveReactionParticipant(params.msg);
  return {
    status: "prepared" as const,
    chatId: params.msg.platform.chatJid,
    messageId,
    emoji,
    reactionOptions: {
      verbose: params.verbose,
      fromMe: params.msg.platform.fromMe === true,
      ...(participant ? { participant } : {}),
      accountId,
      cfg: params.cfg,
    } satisfies Parameters<typeof sendReactionWhatsApp>[3],
  };
}
