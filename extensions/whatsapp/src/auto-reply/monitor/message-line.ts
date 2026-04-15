import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { getPrimaryIdentityId, getReplyContext, getSenderIdentity } from "../../identity.js";
import type { WebInboundMsg } from "../types.js";
import {
  formatInboundEnvelope,
  resolveMessagePrefix,
  type EnvelopeFormatOptions,
} from "./message-line.runtime.js";

export function formatReplyContext(msg: WebInboundMsg) {
  const replyTo = getReplyContext(msg);
  if (!replyTo?.body) {
    return null;
  }
  const sender = replyTo.sender?.label ?? replyTo.sender?.e164 ?? "unknown sender";
  const idPart = replyTo.id ? ` id:${replyTo.id}` : "";
  return `[Replying to ${sender}${idPart}]\n${replyTo.body}\n[/Replying]`;
}

export function buildInboundLine(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
  previousTimestamp?: number;
  envelope?: EnvelopeFormatOptions;
}) {
  const { cfg, msg, agentId, previousTimestamp, envelope } = params;
  // WhatsApp inbound prefix: channels.whatsapp.messagePrefix > legacy messages.messagePrefix > identity/defaults
  const messagePrefix = resolveMessagePrefix(cfg, agentId, {
    configured: cfg.channels?.whatsapp?.messagePrefix,
    hasAllowFrom: (cfg.channels?.whatsapp?.allowFrom?.length ?? 0) > 0,
  });
  const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
  const replyContext = formatReplyContext(msg);
  const baseLine = `${prefixStr}${msg.body}${replyContext ? `\n\n${replyContext}` : ""}`;
  const sender = getSenderIdentity(msg);

  // Wrap with standardized envelope for the agent.
  return formatInboundEnvelope({
    channel: "WhatsApp",
    from: msg.chatType === "group" ? msg.from : msg.from?.replace(/^whatsapp:/, ""),
    timestamp: msg.timestamp,
    body: baseLine,
    chatType: msg.chatType,
    sender: {
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
      id: getPrimaryIdentityId(sender) ?? undefined,
    },
    previousTimestamp,
    envelope,
    fromMe: msg.fromMe,
  });
}
