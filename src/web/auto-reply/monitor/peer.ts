import { jidToE164, normalizeE164 } from "../../../utils.js";
import type { WebInboundMsg } from "../types.js";

export function resolvePeerId(msg: WebInboundMsg) {
  if (msg.chatType === "group") return msg.conversationId ?? msg.from;
  if (msg.senderE164) return normalizeE164(msg.senderE164) ?? msg.senderE164;
  if (msg.from.includes("@")) return jidToE164(msg.from) ?? msg.from;
  return normalizeE164(msg.from) ?? msg.from;
}
