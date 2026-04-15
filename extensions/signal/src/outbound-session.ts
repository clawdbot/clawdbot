import { type RoutePeer } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveSignalPeerId, resolveSignalRecipient, resolveSignalSender } from "./identity.js";
import { looksLikeUuid } from "./uuid.js";

export type ResolvedSignalOutboundTarget = {
  peer: RoutePeer;
  chatType: "direct" | "group";
  from: string;
  to: string;
};

export function resolveSignalOutboundTarget(target: string): ResolvedSignalOutboundTarget | null {
  const stripped = target.replace(/^signal:/i, "").trim();
  const lowered = normalizeLowercaseStringOrEmpty(stripped);
  if (lowered.startsWith("group:")) {
    const groupId = stripped.slice("group:".length).trim();
    if (!groupId) {
      return null;
    }
    return {
      peer: { kind: "group", id: groupId },
      chatType: "group",
      from: `group:${groupId}`,
      to: `group:${groupId}`,
    };
  }

  let recipient = stripped.trim();
  if (lowered.startsWith("username:")) {
    recipient = stripped.slice("username:".length).trim();
  } else if (lowered.startsWith("u:")) {
    recipient = stripped.slice("u:".length).trim();
  }
  if (!recipient) {
    return null;
  }

  const uuidCandidate = normalizeLowercaseStringOrEmpty(recipient).startsWith("uuid:")
    ? recipient.slice("uuid:".length)
    : recipient;
  const sender = resolveSignalSender({
    sourceUuid: looksLikeUuid(uuidCandidate) ? uuidCandidate : null,
    sourceNumber: looksLikeUuid(uuidCandidate) ? null : recipient,
  });
  const peerId = sender ? resolveSignalPeerId(sender) : recipient;
  const displayRecipient = sender ? resolveSignalRecipient(sender) : recipient;
  return {
    peer: { kind: "direct", id: peerId },
    chatType: "direct",
    from: `signal:${displayRecipient}`,
    to: `signal:${displayRecipient}`,
  };
}
