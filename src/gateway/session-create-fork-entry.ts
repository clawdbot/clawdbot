import { buildMainSessionRecoveryClearPatch } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";

export function buildForkedGatewaySessionEntry(
  entry: SessionEntry,
  fork: { sessionId: string; sessionFile: string },
  forkSource: NonNullable<SessionEntry["forkSource"]>,
  previousEntry?: SessionEntry,
): SessionEntry {
  // Replacing the transcript identity also replaces the recovery episode owned by the old row.
  return {
    ...entry,
    ...buildMainSessionRecoveryClearPatch(entry),
    sessionId: fork.sessionId,
    lifecycleRunId: undefined,
    forkSource: previousEntry?.forkSource ?? forkSource,
    ...(previousEntry?.sessionId && previousEntry.sessionId !== fork.sessionId
      ? { previousSessionId: previousEntry.sessionId }
      : {}),
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
  };
}

export function buildRecoveredGatewaySessionEntry(
  entry: SessionEntry,
  recovered: { sessionId: string; sessionFile: string },
  source: SessionEntry,
): SessionEntry {
  // Internal rows intentionally omit the retired sessionFile field; the accessor
  // has already committed the recovered transcript under the successor key.
  return {
    ...entry,
    ...buildMainSessionRecoveryClearPatch(entry),
    sessionId: recovered.sessionId,
    previousSessionId: source.sessionId,
    lifecycleRunId: undefined,
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
  };
}

export function buildArchivedRecoverySourceEntry(
  source: SessionEntry,
  params: {
    archivedBy?: SessionCreatedActor;
    now?: number;
    recoveredSessionId: string;
    recoveredSessionKey: string;
  },
): SessionEntry {
  const now = params.now ?? Date.now();
  const archived: SessionEntry = {
    ...source,
    mainRestartRecovery: source.mainRestartRecovery
      ? {
          ...source.mainRestartRecovery,
          tombstone: source.mainRestartRecovery.tombstone
            ? {
                ...source.mainRestartRecovery.tombstone,
                recoveredSessionId: params.recoveredSessionId,
                recoveredSessionKey: params.recoveredSessionKey,
              }
            : undefined,
        }
      : undefined,
    archivedAt: source.archivedAt ?? now,
    ...(source.archivedBy === undefined && params.archivedBy
      ? { archivedBy: params.archivedBy }
      : {}),
    updatedAt: Math.max(now, (source.updatedAt ?? 0) + 1),
  };
  delete archived.pinnedAt;
  return archived;
}
