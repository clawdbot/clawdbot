import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createSessionIdentityMutationFence,
  type SessionIdentityMutationFence,
} from "../sessions/session-lifecycle-events.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";

export type GatewaySessionTranscriptUpdate = InternalSessionTranscriptUpdate & {
  identityMutationFence?: SessionIdentityMutationFence;
};

export type PreparedGatewayTranscriptEventDispatch = {
  event: GatewaySessionTranscriptUpdate;
  release: () => void;
};

/** Captures transcript identity before lazy handler loading can cross a reset or delete. */
export function prepareGatewayTranscriptEventDispatch(
  update: InternalSessionTranscriptUpdate,
): PreparedGatewayTranscriptEventDispatch {
  const sessionKey =
    normalizeOptionalString(update.target?.sessionKey) ??
    normalizeOptionalString(update.sessionKey);
  if (!sessionKey) {
    return { event: update, release: () => {} };
  }
  const identityMutationFence = createSessionIdentityMutationFence({
    sessionKey,
    sessionId:
      normalizeOptionalString(update.target?.sessionId) ??
      normalizeOptionalString(update.sessionId),
  });
  return {
    event: { ...update, identityMutationFence },
    release: identityMutationFence.release,
  };
}
