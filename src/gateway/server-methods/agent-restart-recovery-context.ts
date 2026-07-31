import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";

type AgentRestartRecoveryChannelContext = {
  channel: string;
  currentChannelId: string;
  currentThreadTs?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  sameChannelThreadRequired: boolean;
  sourceTurnId: string;
};

/** Rehydrates durable channel authority only for the exact host-owned recovery run. */
export function resolveAgentRestartRecoveryChannelContext(params: {
  canUseInternalRuntimeHandoff: boolean;
  expectedExistingSessionId?: string;
  resolvedSessionId?: string;
  runId: string;
  sessionEntry?: SessionEntry;
}): AgentRestartRecoveryChannelContext | undefined {
  const expectedSessionId = normalizeOptionalString(params.expectedExistingSessionId);
  const authority = params.sessionEntry
    ? resolveRestartRecoveryChannelAuthority(params.sessionEntry)
    : undefined;
  if (
    !params.canUseInternalRuntimeHandoff ||
    !expectedSessionId ||
    expectedSessionId !== normalizeOptionalString(params.resolvedSessionId) ||
    expectedSessionId !== normalizeOptionalString(params.sessionEntry?.sessionId) ||
    !authority ||
    normalizeOptionalString(params.sessionEntry?.restartRecoveryDeliveryRunId) !== params.runId
  ) {
    return undefined;
  }
  return {
    channel: authority.deliveryContext.channel,
    currentChannelId: authority.deliveryContext.to,
    currentThreadTs:
      authority.deliveryContext.threadId != null
        ? String(authority.deliveryContext.threadId)
        : undefined,
    sourceTurnId: authority.sourceTurnId,
    requesterAccountId: normalizeOptionalString(
      params.sessionEntry?.restartRecoveryRequesterAccountId,
    ),
    requesterSenderId: normalizeOptionalString(
      params.sessionEntry?.restartRecoveryRequesterSenderId,
    ),
    sameChannelThreadRequired:
      params.sessionEntry?.restartRecoverySameChannelThreadRequired === true,
  };
}
