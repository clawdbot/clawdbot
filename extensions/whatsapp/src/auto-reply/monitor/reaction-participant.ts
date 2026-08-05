// Whatsapp plugin module resolves reaction participant keys.
import { getSenderIdentity } from "../../identity.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";

export function resolveReactionParticipant(msg: AdmittedWebInboundMessage): string | undefined {
  const sender = getSenderIdentity(msg);
  return sender.jid ?? sender.lid ?? undefined;
}
