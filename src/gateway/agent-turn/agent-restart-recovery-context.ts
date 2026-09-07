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

/** Reconstructs presentation and delivery facts from one exact host-owned recovery claim. */
export function resolveAgentRestartRecoveryContext(params: {
  isRestartRecoveryResumeRun: boolean;
  canUseInternalRuntimeHandoff: boolean;
  expectedExistingSessionId?: string;
  resolvedSessionId?: string;
  runId: string;
  sessionEntry?: SessionEntry;
}): { channel?: AgentRestartRecoveryChannelContext; pinnedWidgetAuthoring?: true } | undefined {
  const expectedSessionId = normalizeOptionalString(params.expectedExistingSessionId);
  const entry = params.sessionEntry;
  if (
    !params.canUseInternalRuntimeHandoff ||
    !expectedSessionId ||
    !entry ||
    expectedSessionId !== normalizeOptionalString(params.resolvedSessionId) ||
    expectedSessionId !== normalizeOptionalString(entry.sessionId) ||
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== params.runId
  ) {
    return undefined;
  }
  if (
    params.isRestartRecoveryResumeRun &&
    entry.restartRecoverySourceIngress === "control-ui" &&
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId)
  ) {
    return { pinnedWidgetAuthoring: true };
  }
  const authority = resolveRestartRecoveryChannelAuthority(entry);
  return authority
    ? {
        channel: {
          channel: authority.deliveryContext.channel,
          currentChannelId: authority.deliveryContext.to,
          currentThreadTs:
            authority.deliveryContext.threadId != null
              ? String(authority.deliveryContext.threadId)
              : undefined,
          sourceTurnId: authority.sourceTurnId,
          requesterAccountId: normalizeOptionalString(entry.restartRecoveryRequesterAccountId),
          requesterSenderId: normalizeOptionalString(entry.restartRecoveryRequesterSenderId),
          sameChannelThreadRequired: entry.restartRecoverySameChannelThreadRequired === true,
        },
      }
    : undefined;
}

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
