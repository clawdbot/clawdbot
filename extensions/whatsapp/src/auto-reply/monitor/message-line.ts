// Whatsapp plugin module implements message line behavior.
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSenderIdentity,
  type WhatsAppReplyContext,
} from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { formatInboundEnvelope, type EnvelopeFormatOptions } from "./message-line.runtime.js";

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
  msg: AdmittedWebInboundMessage;
  previousTimestamp?: number;
  envelope?: EnvelopeFormatOptions;
  visibleReplyTo?: WhatsAppReplyContext | null;
}) {
  const { msg, previousTimestamp, envelope } = params;
  const admission = requireWhatsAppInboundAdmission(msg);
  const conversationId = admission.conversation.id;
  const conversationKind = admission.conversation.kind;
  const replyContext =
    params.visibleReplyTo === undefined
      ? formatReplyContext(msg)
      : formatReplyTarget(params.visibleReplyTo);
  const baseLine = `${msg.payload.body}${replyContext ? `\n\n${replyContext}` : ""}`;
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
