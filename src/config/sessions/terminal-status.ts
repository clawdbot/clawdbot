import type { SessionEntry } from "./types.js";

/** Returns true for terminal statuses that a later visible turn may recover in place. */
export function isRecoverableTerminalSessionStatus(
  status: SessionEntry["status"] | undefined,
): boolean {
  return status === "failed" || status === "timeout" || status === "killed";
}

/** Clears stale terminal lifecycle fields before reusing a recoverable session entry. */
export function recoverTerminalSessionEntryForVisibleTurn(entry: SessionEntry): SessionEntry {
  return {
    ...entry,
    status: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    lastRunError: undefined,
    abortedLastRun: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryDeliveryContext: undefined,
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoveryDisableMessageTool: undefined,
    restartRecoverySuppressTextDelivery: undefined,
    restartRecoveryDeliveryRequestFingerprint: undefined,
    restartRecoveryDeliveryRunId: undefined,
    restartRecoveryDeliverySourceRunId: undefined,
    restartRecoverySourceReplyDeliveryMode: undefined,
  };
}
