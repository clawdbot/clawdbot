/** Lazy session identity creation, including the original admission's first writer claim. */
import {
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionAccessScope,
  SessionTranscriptWriteScope,
} from "./session-accessor.sqlite-contract.js";
import {
  collectSessionEntryLookupKeys,
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import {
  assertOwnedTranscriptWriteCommit,
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Creates a missing session identity without replacing a concurrently owned row. */
export function ensureSessionEntrySync(
  scope: SessionAccessScope &
    Pick<SessionTranscriptWriteScope, "expectedLifecycleRevision" | "expectedWriterRunId">,
  entry: SessionEntry,
): boolean {
  const initialWriter = getOwnedSessionTranscriptInitialWriter({
    sessionTarget: { ...scope, sessionId: entry.sessionId },
  });
  const initializing = initialWriter && !initialWriter.committedFence;
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteScope(fencedScope);
  assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
  let owned = false;
  const publishCommitted = runOpenClawAgentWriteTransaction((database) => {
    assertOwnedTranscriptWriteCommit({ ...fencedScope, sessionId: entry.sessionId });
    const identityKeys = collectSessionEntryLookupKeys(database, resolved.sessionKey);
    const previous = readSessionIdentitySnapshot(database, identityKeys);
    const existing = readSessionEntryRow(database, resolved.sessionKey)?.entry;
    if (existing) {
      // Initial leases require absence, even for copied ids. Repeated initial appends inside
      // one outer transaction are unsupported; normal SessionManager writes commit separately.
      if (initializing) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      // Existing writers retain the read-only probe; the following append validates their fence.
      owned = existing.sessionId === entry.sessionId;
      return undefined;
    }
    if (fencedScope.expectedWriterRunId !== undefined && !initializing) {
      return undefined;
    }
    const persisted = writeSessionEntry(
      database,
      resolved.sessionKey,
      initializing ? { ...entry, activeWriterRunId: initialWriter.writerRunId } : entry,
    );
    const current = readSessionIdentitySnapshot(database, identityKeys);
    owned = current.get(resolved.sessionKey)?.sessionId === entry.sessionId;
    const publish = prepareSessionIdentityPublication(
      database,
      resolved.agentId,
      previous,
      current,
    );
    if (initializing) {
      if (!owned || persisted.activeWriterRunId !== initialWriter.writerRunId) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      const fence = {
        expectedLifecycleRevision: persisted.lifecycleRevision,
        expectedWriterRunId: persisted.activeWriterRunId,
      };
      // Savepoint success is not COMMIT. The existing transaction owner discards this on rollback.
      if (
        !deferOpenClawAgentPostCommitPublication(database, () => {
          try {
            initialWriter.recordCommitted(fence);
          } finally {
            publish();
          }
        })
      ) {
        throw new Error("initial session writer requires a managed commit boundary");
      }
    }
    return publish;
  }, toDatabaseOptions(resolved));
  if (!initializing) {
    publishCommitted?.();
  }
  if (fencedScope.expectedWriterRunId !== undefined && !owned) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return owned;
}
