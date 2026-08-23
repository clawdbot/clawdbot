// Whatsapp plugin module implements peer behavior.
import { getSenderIdentity } from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { jidToE164, normalizeE164 } from "../../text-runtime.js";

export function resolvePeerId(msg: AdmittedWebInboundMessage) {
  const admission = requireWhatsAppInboundAdmission(msg);
  if (admission.conversation.kind === "group") {
    return admission.conversation.id;
  }
  const sender = getSenderIdentity(msg);
  if (sender.e164) {
    return normalizeE164(sender.e164) ?? sender.e164;
  }
  const conversationId = admission.conversation.id;
  if (conversationId.includes("@")) {
    return jidToE164(conversationId) ?? conversationId;
  }
  return normalizeE164(conversationId) ?? conversationId;
}
