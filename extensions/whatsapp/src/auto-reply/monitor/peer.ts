import { getSenderIdentity } from "../../identity.js";
import { jidToE164, normalizeE164 } from "../../text-runtime.js";
import type { WebInboundMsg } from "../types.js";

export function resolvePeerId(msg: WebInboundMsg) {
  if (msg.chatType === "group") {
    return msg.conversationId ?? msg.from;
  }
  const sender = getSenderIdentity(msg);
  if (sender.e164) {
    return normalizeE164(sender.e164) ?? sender.e164;
  }
  if (msg.from.includes("@")) {
    return jidToE164(msg.from) ?? msg.from;
  }
  return normalizeE164(msg.from) ?? msg.from;
}
