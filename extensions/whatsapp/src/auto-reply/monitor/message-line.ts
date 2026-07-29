// Whatsapp plugin module implements message line behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSenderIdentity,
  type WhatsAppReplyContext,
} from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  formatInboundEnvelope,
  resolveMessagePrefix,
  type EnvelopeFormatOptions,
} from "./message-line.runtime.js";

function formatReplyTarget(replyTo: WhatsAppReplyContext | null) {
  if (!replyTo?.body) {
    return null;
  }
  const sender = replyTo.sender?.label ?? replyTo.sender?.e164 ?? "unknown sender";
  const idPart = replyTo.id ? ` id:${replyTo.id}` : "";
  return `[Replying to ${sender}${idPart}]\n${replyTo.body}\n[/Replying]`;
}

function formatReplyContext(msg: AdmittedWebInboundMessage) {
  return formatReplyTarget(getReplyContext(msg));
}

export function buildInboundLine(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  agentId: string;
  previousTimestamp?: number;
  envelope?: EnvelopeFormatOptions;
  visibleReplyTo?: WhatsAppReplyContext | null;
}) {
  const { cfg, msg, agentId, previousTimestamp, envelope } = params;
  // WhatsApp inbound prefix: channels.whatsapp.responsePrefix > identity/defaults.
  const messagePrefix = resolveMessagePrefix(cfg, agentId, {
    configured: cfg.channels?.whatsapp?.responsePrefix,
    hasAllowFrom: (cfg.channels?.whatsapp?.allowFrom?.length ?? 0) > 0,
  });
  const admission = requireWhatsAppInboundAdmission(msg);
  const conversationId = admission.conversation.id;
  const conversationKind = admission.conversation.kind;
  const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
  const replyContext =
    params.visibleReplyTo === undefined
      ? formatReplyContext(msg)
      : formatReplyTarget(params.visibleReplyTo);
  const baseLine = `${prefixStr}${msg.payload.body}${replyContext ? `\n\n${replyContext}` : ""}`;
  const sender = getSenderIdentity(msg);

  // Wrap with standardized envelope for the agent.
  return formatInboundEnvelope({
    channel: "WhatsApp",
    from: conversationKind === "group" ? conversationId : conversationId.replace(/^whatsapp:/, ""),
    timestamp: msg.event.timestamp,
    body: baseLine,
    chatType: conversationKind,
    sender: {
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
      id: getPrimaryIdentityId(sender) ?? undefined,
    },
    previousTimestamp,
    envelope,
    fromMe: msg.platform.fromMe,
  });
}
