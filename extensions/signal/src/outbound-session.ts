// Signal plugin module implements outbound session behavior.
import type { RoutePeer } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalPeerId, resolveSignalRecipient, resolveSignalSender } from "./identity.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { looksLikeUuid } from "./uuid.js";

export type ResolvedSignalOutboundTarget = {
  peer: RoutePeer;
  chatType: "direct" | "group";
  from: string;
  to: string;
};

export function resolveSignalOutboundTarget(target: string): ResolvedSignalOutboundTarget | null {
  const normalized = normalizeSignalMessagingTarget(target);
  if (!normalized) {
    return null;
  }
  const lowered = normalizeLowercaseStringOrEmpty(normalized);
  if (lowered.startsWith("group:")) {
    const groupId = normalized.slice("group:".length);
    return {
      peer: { kind: "group", id: groupId },
      chatType: "group",
      from: `group:${groupId}`,
      to: `group:${groupId}`,
    };
  }

  if (lowered.startsWith("username:")) {
    // Keep delivery and session identity on the canonical username target. Phone normalization
    // would digit-strip the username and could collide with a real phone session.
    return {
      peer: { kind: "direct", id: normalized },
      chatType: "direct",
      from: `signal:${normalized}`,
      to: `signal:${normalized}`,
    };
  }

  const recipient = normalized;

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
