import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptAccessScope,
  SessionTranscriptWriteScope,
  TranscriptEvent,
  TranscriptEventAppendError,
  TranscriptEventAppendOptions,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  readTranscriptEventRows,
  type SqliteTranscriptSnapshotRow,
} from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

// Raw (non-message) transcript event append family. Split out of
// session-accessor.sqlite-transcript-write.ts to keep that file under the
// repo's line limit; message and replace/rewrite writers stay there.

/** Appends one raw transcript event to the additive SQLite transcript store. */
export async function appendTranscriptEvent(
  scope: SessionTranscriptAccessScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
): Promise<void> {
  assertNonMessageTranscriptEvent(event);
  const resolved = resolveSqliteTranscriptScope(scope);
  await runExclusiveSqliteSessionWrite(resolved, async () => {
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventInTransaction(
        database,
        resolved,
        resolveTranscriptEventAppendParent(database, resolved.sessionId, event, options),
      );
    }, toDatabaseOptions(resolved));
  });
}

/**
 * Shared transaction body for the sync event-append entry points. `afterAppend` runs
 * inside the same write transaction immediately after a successful insert, so a caller
 * that needs the resulting row set (e.g. to track a last-known-good snapshot) reads it
 * atomically instead of racing a foreign commit that could land after this transaction
 * commits but before a separate out-of-transaction read.
 */
function appendTranscriptEventSyncCore(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions,
  afterAppend?: (database: OpenClawAgentDatabase, resolved: { sessionId: string }) => void,
): Result<boolean, TranscriptEventAppendError> {
  assertNonMessageTranscriptEvent(event);
  // Every sync event append inherits and enforces the admitted writer claim.
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let result: Result<boolean, TranscriptEventAppendError> = ok(false);
  runOpenClawAgentWriteTransaction((database) => {
    const fresh = readSessionEntryRow(database, resolved.sessionKey);
    if (!fresh) {
      result = err({
        code: "session-entry-missing",
        expectedSessionId: resolved.sessionId,
        sessionKey: resolved.sessionKey,
      });
      return;
    }
    if (fresh.entry.sessionId !== resolved.sessionId) {
      result = err({
        actualSessionId: fresh.entry.sessionId,
        code: "session-rebound",
        expectedSessionId: resolved.sessionId,
        sessionKey: resolved.sessionKey,
      });
      return;
    }
    if (
      (fencedScope.expectedLifecycleRevision !== undefined &&
        fresh.entry.lifecycleRevision !== fencedScope.expectedLifecycleRevision) ||
      (fencedScope.expectedWriterRunId !== undefined &&
        // SAFETY: readSessionEntryRow always resolves the internal runtime row shape, which declares activeWriterRunId.
        (fresh.entry as InternalSessionEntry).activeWriterRunId !== fencedScope.expectedWriterRunId)
    ) {
      result = err({
        actualSessionId: fresh.entry.sessionId,
        code: "session-rebound",
        expectedSessionId: resolved.sessionId,
        sessionKey: resolved.sessionKey,
      });
      return;
    }
    const appended = appendTranscriptEventInTransaction(
      database,
      resolved,
      resolveTranscriptEventAppendParent(database, resolved.sessionId, event, options),
    );
    result = ok(appended);
    if (appended) {
      afterAppend?.(database, resolved);
    }
  }, toDatabaseOptions(resolved));
  if (fencedScope.expectedWriterRunId !== undefined && !result.ok) {
    throw new SessionTranscriptWriterClaimReboundError(scope.sessionKey);
  }
  return result;
}

/** Appends one raw non-message transcript event synchronously for sync session runtimes. */
export function appendTranscriptEventSync(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
): Result<boolean, TranscriptEventAppendError> {
  return appendTranscriptEventSyncCore(scope, event, options);
}

/**
 * Appends one raw non-message transcript event and atomically captures the post-append
 * row snapshot in the same write transaction. Callers that track their own last-known-good
 * snapshot (e.g. SessionManagerCore) must use this instead of appendTranscriptEventSync plus
 * a separate loadTranscriptRowSnapshotSync call: a foreign process committing between this
 * transaction's commit and that later read would otherwise be silently folded into the
 * tracked snapshot without ever appearing in the caller's in-memory entries.
 */
export function appendTranscriptEventWithSnapshotSync(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
): {
  result: Result<boolean, TranscriptEventAppendError>;
  snapshot?: SqliteTranscriptSnapshotRow[];
} {
  let snapshot: SqliteTranscriptSnapshotRow[] | undefined;
  const result = appendTranscriptEventSyncCore(scope, event, options, (database, resolved) => {
    snapshot = readTranscriptEventRows(database, resolved.sessionId);
  });
  return { result, ...(snapshot ? { snapshot } : {}) };
}

function resolveTranscriptEventAppendParent(
  database: OpenClawAgentDatabase,
  sessionId: string,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions,
): TranscriptEvent {
  if (
    options.appendIntent !== "active-branch" ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    !("parentId" in event)
  ) {
    return event;
  }
  const parentId = event.parentId;
  if (parentId !== null && typeof parentId !== "string") {
    return event;
  }
  const effectiveParentId = resolveTranscriptMessageAppendParent(database, sessionId, {
    appendIntent: "active-branch",
    parentId,
  });
  return effectiveParentId === parentId ? event : { ...event, parentId: effectiveParentId };
}

function assertNonMessageTranscriptEvent(event: TranscriptEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }
  // Message records require parent-link, idempotency, and redaction handling
  // from appendTranscriptMessage; raw event writes would bypass those invariants.
  // SAFETY: event is confirmed non-null, non-array, and object-typed above; probing an optional `type` field is safe.
  if ((event as { type?: unknown }).type === "message") {
    throw new Error(
      "appendTranscriptEvent cannot write message transcript records; use appendTranscriptMessage instead.",
    );
  }
}
