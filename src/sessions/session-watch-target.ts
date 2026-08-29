import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";

const ENCODED_TARGET_PREFIX = "session-state-target:";

export type SessionStateWatchTarget = {
  sessionKey: string;
  agentId: string;
};

/** Bare session keys need an agent-owned storage identity in shared cursors. */
export function encodeSessionStateWatchTarget(target: SessionStateWatchTarget): string {
  const keyAgentId = parseAgentSessionKey(target.sessionKey)?.agentId;
  if (
    keyAgentId &&
    normalizeOptionalLowercaseString(keyAgentId) ===
      normalizeOptionalLowercaseString(target.agentId)
  ) {
    return target.sessionKey;
  }
  return `${ENCODED_TARGET_PREFIX}${Buffer.from(
    JSON.stringify([target.agentId, target.sessionKey]),
    "utf8",
  ).toString("base64url")}`;
}

export function decodeSessionStateWatchTarget(value: string): SessionStateWatchTarget | undefined {
  if (!value.startsWith(ENCODED_TARGET_PREFIX)) {
    const agentId = parseAgentSessionKey(value)?.agentId;
    return agentId ? { sessionKey: value, agentId } : undefined;
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value.slice(ENCODED_TARGET_PREFIX.length), "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string" ||
      !decoded[0] ||
      !decoded[1]
    ) {
      return undefined;
    }
    return { agentId: decoded[0], sessionKey: decoded[1] };
  } catch {
    return undefined;
  }
}
