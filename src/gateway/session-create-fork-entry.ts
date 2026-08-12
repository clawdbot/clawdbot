import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";

export function buildForkedGatewaySessionEntry(
  entry: SessionEntry,
  fork: { sessionId: string; sessionFile: string },
  forkSource: NonNullable<SessionEntry["forkSource"]>,
  previousEntry?: SessionEntry,
): SessionEntry {
  // Replacing the transcript identity also replaces the recovery policy and episode of the old row.
  return {
    ...entry,
    ...buildMainSessionRecoveryClearPatch(entry),
    sessionId: fork.sessionId,
    lifecycleRunId: undefined,
    restartRecoveryOwner: undefined,
    forkSource: previousEntry?.forkSource ?? forkSource,
    ...(previousEntry?.sessionId && previousEntry.sessionId !== fork.sessionId
      ? { previousSessionId: previousEntry.sessionId }
      : {}),
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
  };
}
