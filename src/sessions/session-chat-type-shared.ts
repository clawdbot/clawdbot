// Shared session chat type helpers expose cross-module chat type classification.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "./session-key-utils.js";

export type SessionKeyChatType = "direct" | "group" | "channel" | "unknown";

type CanonicalPeerKind = "direct" | "dm" | "group" | "channel";

const CANONICAL_PEER_KINDS: ReadonlySet<string> = new Set(["direct", "dm", "group", "channel"]);

function isCanonicalPeerKind(value: string | undefined): value is CanonicalPeerKind {
  return CANONICAL_PEER_KINDS.has(value ?? "");
}

type CanonicalSessionPeerShape = {
  channel?: string;
  chatType: Exclude<SessionKeyChatType, "unknown">;
};

export function hasAmbiguousCanonicalSessionPeerShape(scopedSessionKey: string): boolean {
  const parts = scopedSessionKey.split(":");
  if (parts[0] === "agent") {
    return false;
  }
  const hasBareDirectPeerShape = Boolean((parts[0] === "direct" || parts[0] === "dm") && parts[1]);
  const hasChannelPeerShape = Boolean(parts[0] && isCanonicalPeerKind(parts[1]) && parts[2]);
  const hasAccountPeerShape = Boolean(
    parts[0] && parts[1] && isCanonicalPeerKind(parts[2]) && parts[3],
  );
  const hasBuiltInLegacyPeerShape =
    deriveBuiltInLegacySessionChatType(scopedSessionKey) !== undefined;
  return (
    [
      hasBareDirectPeerShape,
      hasChannelPeerShape,
      hasAccountPeerShape,
      hasBuiltInLegacyPeerShape,
    ].filter(Boolean).length > 1
  );
}

export function parseCanonicalSessionPeerShape(
  scopedSessionKey: string,
): CanonicalSessionPeerShape | undefined {
  const parts = scopedSessionKey.split(":");
  // A second agent wrapper is opaque plugin identity, never a channel route.
  if (parts[0] === "agent" || hasAmbiguousCanonicalSessionPeerShape(scopedSessionKey)) {
    return undefined;
  }
  let channel: string | undefined;
  let peerKind: CanonicalPeerKind | undefined;
  let peerIdStart = 0;
  if (parts[0] === "direct" || parts[0] === "dm") {
    peerKind = parts[0];
    peerIdStart = 1;
  } else if (parts[0] && isCanonicalPeerKind(parts[1])) {
    channel = parts[0];
    peerKind = parts[1];
    peerIdStart = 2;
  } else if (parts[0] && parts[1] && isCanonicalPeerKind(parts[2])) {
    channel = parts[0];
    peerKind = parts[2];
    peerIdStart = 3;
  }
  // Peer ids are opaque tails and may contain empty colon-delimited segments.
  // Only the structural prefix and first peer-id segment must be present.
  if (!peerKind || !parts[peerIdStart]) {
    return undefined;
  }
  const chatType = peerKind === "direct" || peerKind === "dm" ? "direct" : peerKind;
  return { ...(channel ? { channel } : {}), chatType };
}

function deriveCanonicalSessionChatType(scopedSessionKey: string): SessionKeyChatType | undefined {
  return parseCanonicalSessionPeerShape(scopedSessionKey)?.chatType;
}

function deriveBuiltInLegacySessionChatType(
  scopedSessionKey: string,
): SessionKeyChatType | undefined {
  if (/^group:[^:]+(?::.*)?$/u.test(scopedSessionKey)) {
    return "group";
  }
  if (/^channel:[^:]+(?::.*)?$/u.test(scopedSessionKey)) {
    return "channel";
  }
  if (/^(?:whatsapp:)?[^:]+@g\.us$/.test(scopedSessionKey)) {
    return "group";
  }
  if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/.test(scopedSessionKey)) {
    return "channel";
  }
  return undefined;
}

function deriveSessionChatTypeFromScopedKey(
  scopedSessionKey: string,
  deriveLegacySessionChatTypes: Array<
    (scopedSessionKey: string) => SessionKeyChatType | undefined
  > = [],
): SessionKeyChatType {
  const canonical = deriveCanonicalSessionChatType(scopedSessionKey);
  if (canonical) {
    return canonical;
  }
  const builtInLegacy = deriveBuiltInLegacySessionChatType(scopedSessionKey);
  if (builtInLegacy) {
    return builtInLegacy;
  }
  for (const deriveLegacySessionChatType of deriveLegacySessionChatTypes) {
    const derived = deriveLegacySessionChatType(scopedSessionKey);
    if (derived) {
      return derived;
    }
  }
  return "unknown";
}

/**
 * Best-effort chat-type extraction from session keys across canonical and legacy formats.
 */
export function deriveSessionChatTypeFromKey(
  sessionKey: string | undefined | null,
  deriveLegacySessionChatTypes: Array<
    (scopedSessionKey: string) => SessionKeyChatType | undefined
  > = [],
): SessionKeyChatType {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return "unknown";
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  return deriveSessionChatTypeFromScopedKey(scoped, deriveLegacySessionChatTypes);
}
