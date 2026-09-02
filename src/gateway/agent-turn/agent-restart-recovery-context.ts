import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createExecutionIdentityRecoveryAdmission } from "../../agents/admitted-run-context.js";
import { parseExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
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

/** Resolve only the private token durably owned by the admitted recovery cycle. */
export function resolveAgentRestartRecoveryExecutionIdentityAdmission(params: {
  collectionEnabled: boolean;
  isRestartRecoveryResumeRun: boolean;
  retryOnly?: boolean;
  runId: string;
  sessionEntry?: SessionEntry;
}) {
  if (!params.isRestartRecoveryResumeRun || !params.collectionEnabled) {
    return undefined;
  }
  if (params.retryOnly === undefined) {
    throw new Error("restart recovery execution identity admission mode is unavailable");
  }
  const stored = (params.sessionEntry as InternalSessionEntry | undefined)?.mainRestartRecovery
    ?.executionIdentity;
  if (!stored) {
    return createExecutionIdentityRecoveryAdmission({
      retryOnly: params.retryOnly,
      expectedOperationalRunId: params.runId,
    });
  }
  const token = parseExecutionIdentityAdmissionToken(stored);
  return createExecutionIdentityRecoveryAdmission({
    token,
    retryOnly: params.retryOnly,
    expectedOperationalRunId: params.runId,
  });
}

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
