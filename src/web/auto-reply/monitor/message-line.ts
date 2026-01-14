import { resolveMessagePrefix } from "../../../agents/identity.js";
import { formatAgentEnvelope } from "../../../auto-reply/envelope.js";
import type { loadConfig } from "../../../config/config.js";
import type { WebInboundMsg } from "../types.js";

export function formatReplyContext(msg: WebInboundMsg) {
  if (!msg.replyToBody) return null;
  const sender = msg.replyToSender ?? "unknown sender";
  const idPart = msg.replyToId ? ` id:${msg.replyToId}` : "";
  return `[Replying to ${sender}${idPart}]\n${msg.replyToBody}\n[/Replying]`;
}

export function buildInboundLine(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
}) {
  const { cfg, msg, agentId } = params;
  // WhatsApp inbound prefix: channels.whatsapp.messagePrefix > legacy messages.messagePrefix > identity/defaults
  const messagePrefix = resolveMessagePrefix(cfg, agentId, {
    configured: cfg.channels?.whatsapp?.messagePrefix,
    hasAllowFrom: (cfg.channels?.whatsapp?.allowFrom?.length ?? 0) > 0,
  });
  const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
  const senderLabel =
    msg.chatType === "group"
      ? `${msg.senderName ?? msg.senderE164 ?? "Someone"}: `
      : "";
  const replyContext = formatReplyContext(msg);
  const baseLine = `${prefixStr}${senderLabel}${msg.body}${
    replyContext ? `\n\n${replyContext}` : ""
  }`;

  // Wrap with standardized envelope for the agent.
  return formatAgentEnvelope({
    channel: "WhatsApp",
    from:
      msg.chatType === "group" ? msg.from : msg.from?.replace(/^whatsapp:/, ""),
    timestamp: msg.timestamp,
    body: baseLine,
  });
}
