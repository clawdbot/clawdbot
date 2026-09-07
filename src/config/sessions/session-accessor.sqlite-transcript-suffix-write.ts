import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMutationStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  prepareSqliteTranscriptSuffixMutation,
  replaceSqliteTranscriptSuffixInTransaction,
} from "./session-accessor.sqlite-transcript-suffix.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

function transcriptWriteScopeIsCurrent(
  fresh: ReturnType<typeof readSessionEntryRow>,
  resolved: ResolvedTranscriptScope,
  scope: SessionTranscriptWriteScope,
): boolean {
  if (!fresh || fresh.entry.sessionId !== resolved.sessionId) {
    return false;
  }
  // SAFETY: InternalSessionEntry is the persisted superset that owns activeWriterRunId.
  const entry = fresh.entry as InternalSessionEntry;
  return !(
    (scope.expectedLifecycleRevision !== undefined &&
      entry.lifecycleRevision !== scope.expectedLifecycleRevision) ||
    (scope.expectedWriterRunId !== undefined &&
      entry.activeWriterRunId !== scope.expectedWriterRunId)
  );
}

/** Replaces an exact transcript suffix synchronously and rotates its cursor generation. */
export function replaceTranscriptSuffixEventsSync(
  scope: SessionTranscriptWriteScope,
  expectedEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
  prefixLength = 0,
  expectedMutationAt?: number | null,
  captureMutationAtInTransaction?: (mutationAt: number | null) => void,
  eventsStartAtPersistedPrefix = false,
): boolean {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const owner = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const plan = prepareSqliteTranscriptSuffixMutation(
    owner,
    resolved,
    expectedEvents,
    nextEvents,
    prefixLength,
    expectedMutationAt,
    eventsStartAtPersistedPrefix,
  );
  let replaced = false;
  runOpenClawAgentWriteTransaction((database) => {
    assertOwnedTranscriptWriteCommit(fencedScope);
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!transcriptWriteScopeIsCurrent(fresh, resolved, fencedScope)) {
      return;
    }
    replaceSqliteTranscriptSuffixInTransaction(database, resolved, plan);
    captureMutationAtInTransaction?.(
      readTranscriptMutationStateInTransaction(database, resolved.sessionId).updatedAt,
    );
    replaced = true;
  }, toDatabaseOptions(resolved));
  if (fencedScope.expectedWriterRunId !== undefined && !replaced) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return replaced;
}
