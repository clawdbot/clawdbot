import { isDeepStrictEqual } from "node:util";
import type {
  SessionEntry,
  SessionLeafControl,
} from "../../agents/sessions/session-manager-types.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptWriteScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { withSessionPendingInputRelocation } from "./session-accessor.sqlite-pending-inputs.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  readTranscriptContextVersionInTransaction,
  type SessionTranscriptContextVersion,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  redactTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** Capture a constant-size snapshot; the session owner prepares payloads outside the write lock. */
export function prepareTranscriptRewriteSync(
  scope: SessionTranscriptWriteScope,
  appendParentId: string | null,
  assertActive: () => void,
  loadedVersion: SessionTranscriptContextVersion | undefined,
): (
  entries: Array<SessionEntry | SessionLeafControl>,
  sources: ReadonlyMap<string, SessionEntry>,
  adopt: (version: SessionTranscriptContextVersion) => void,
) => void {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  const options = toDatabaseOptions(resolved);
  const database = openOpenClawAgentDatabase(options);
  assertActive();
  assertOwnedTranscriptWriteCommit(fencedScope);
  const version = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
  const conflict = () => new Error("Session transcript changed before rewrite publication");
  if (
    !loadedVersion ||
    version.generation !== loadedVersion.generation ||
    version.rawSeq !== loadedVersion.rawSeq ||
    resolveTranscriptMessageAppendParent(database, resolved.sessionId, {}) !== appendParentId
  ) {
    throw conflict();
  }
  return (entries, sources, adopt) => {
    // A savepoint cannot own admission validation or publication at a later outer commit.
    if (openOpenClawAgentDatabase(options).db.isTransaction) {
      throw new Error(
        "Transcript rewrite must own its commit; run it outside the active transaction",
      );
    }
    // Replays bypass hooks, but retain canonical storage redaction. No payload preparation under BEGIN.
    for (const entry of entries) {
      if (entry.type === "message") {
        entry.message = redactTranscriptMessageForStorage(entry.message, {});
      }
    }
    let committedVersion: SessionTranscriptContextVersion;
    runOpenClawAgentWriteTransaction((current) => {
      // Custody stages commit first; insert observers must also see the committed manager view.
      // The version is assigned before COMMIT; rollback discards this publication.
      if (!deferOpenClawAgentPostCommitPublication(current, () => adopt(committedVersion))) {
        throw new Error("Transcript rewrite requires a commit publication");
      }
      assertActive();
      assertOwnedTranscriptWriteCommit(fencedScope);
      const fresh = readSessionEntryRow(current, resolved.sessionKey);
      const refusal = resolveTranscriptAppendRefusal(fresh?.entry, resolved, fencedScope);
      if (refusal) {
        throw new SessionTranscriptWriterClaimReboundError(refusal);
      }
      const currentVersion = readTranscriptContextVersionInTransaction(current, resolved.sessionId);
      if (
        currentVersion.generation !== version.generation ||
        currentVersion.rawSeq !== version.rawSeq
      ) {
        throw conflict();
      }
      // A loaded manager may predate an in-place repair even when its entry ids match.
      // Compare only the copied suffix, never hydrate the complete archive under the lock.
      for (const source of sources.values()) {
        const row = executeSqliteQueryTakeFirstSync(
          current.db,
          getSessionKysely(current.db)
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("transcript_events as event", (join) =>
              join
                .onRef("event.session_id", "=", "identity.session_id")
                .onRef("event.seq", "=", "identity.seq"),
            )
            .select("event.event_json")
            .where("identity.session_id", "=", resolved.sessionId)
            .where("identity.event_id", "=", source.id),
        );
        if (!row || !isDeepStrictEqual(JSON.parse(row.event_json), source)) {
          throw conflict();
        }
      }
      // The existing append/relocation owners participate in the same transaction.
      // Interruption rolls back entries, key ownership, and receipt publications together.
      for (const entry of entries) {
        assertActive();
        assertOwnedTranscriptWriteCommit(fencedScope);
        if (entry.type === "message") {
          const source = sources.get(entry.id);
          if (!source) {
            throw new Error("Transcript rewrite message has no source entry");
          }
          const result = withSessionPendingInputRelocation(source.id, entry.message, () =>
            appendTranscriptMessageInTransaction(current, resolved, {
              eventId: entry.id,
              parentId: entry.parentId,
              now: Date.parse(entry.timestamp),
              message: entry.message,
              messageAlreadyRedacted: true,
              appendMode: entry.appendMode,
              idempotencyLookup: "caller-checked",
            }),
          );
          if (!result?.appended || result.messageId !== entry.id) {
            throw new Error("Transcript rewrite message was not appended");
          }
          entry.message = result.message;
        } else if (!appendTranscriptEventInTransaction(current, resolved, entry)) {
          throw new Error("Transcript rewrite entry was not appended");
        }
      }
      assertActive();
      assertOwnedTranscriptWriteCommit(fencedScope);
      committedVersion = readTranscriptContextVersionInTransaction(current, resolved.sessionId);
    }, options);
  };
}
