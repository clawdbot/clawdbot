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
  foldPendingTranscriptHeaderInTransaction,
  type PendingTranscriptHeader,
} from "./session-accessor.sqlite-transcript-write.js";
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
      // Authority/participation check must run inside the write transaction, before the
      // append proceeds, so an unauthorized session-lifecycle write is rejected atomically
      // rather than after the fact (see session-accessor.entry-mutation.ts's commitGuard).
      options.beforeCommitInTransaction?.();
      appendTranscriptEventInTransaction(
        database,
        resolved,
        resolveTranscriptEventAppendParent(database, resolved.sessionId, event, options).event,
      );
    }, toDatabaseOptions(resolved));
  });
}

/**
 * Shared transaction body for the sync event-append entry points. `afterAppend` runs
 * inside the same write transaction immediately after a successful insert, so a caller
 * that needs the resulting row set (e.g. to track a last-known-good snapshot) reads it
 * atomically instead of racing a foreign commit that could land after this transaction
 * commits but before a separate out-of-transaction read. It also receives the append's
 * effective (possibly rebased) parentId -- see resolveTranscriptEventAppendParent -- so a
 * caller tracking an in-memory tree can detect a rebase and reconcile it, the same way
 * appendTranscriptMessageInTransaction already surfaces effectiveParentId for messages.
 * `foreignRowDetected` mirrors a `nonThrowing` pendingHeader's row-count mismatch (see
 * PendingTranscriptHeader) -- a foreign row with no non-blank id, invisible to the
 * parentId-based rebase above, that landed since the caller's tracked snapshot.
 */
function appendTranscriptEventSyncCore(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions,
  afterAppend?: (
    database: OpenClawAgentDatabase,
    resolved: { sessionId: string },
    effectiveParentId: string | null | undefined,
    foreignRowDetected: boolean,
  ) => void,
  pendingHeader?: PendingTranscriptHeader,
): Result<boolean, TranscriptEventAppendError> {
  assertNonMessageTranscriptEvent(event);
  // Every sync event append inherits and enforces the admitted writer claim.
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let result: Result<boolean, TranscriptEventAppendError> = ok(false);
  runOpenClawAgentWriteTransaction((database) => {
    // Authority/participation check must run inside the write transaction, before the
    // append proceeds, so an unauthorized session-lifecycle write is rejected atomically
    // rather than after the fact (see session-accessor.entry-mutation.ts's commitGuard).
    options.beforeCommitInTransaction?.();
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
    // Fold a still-pending session header into this same write transaction so the
    // header row and the first record commit atomically. Appending the header in a
    // separate prior transaction leaves a gap where a foreign commit lands after the
    // header but before this append, is folded into the snapshot below, yet never
    // appears in the caller's in-memory entries -- so a later rewrite deletes it.
    const foreignRowDetected = pendingHeader
      ? foldPendingTranscriptHeaderInTransaction(database, resolved, pendingHeader)
      : false;
    const { event: rebasedEvent, effectiveParentId } = resolveTranscriptEventAppendParent(
      database,
      resolved.sessionId,
      event,
      options,
    );
    const appended = appendTranscriptEventInTransaction(database, resolved, rebasedEvent);
    result = ok(appended);
    if (appended) {
      afterAppend?.(database, resolved, effectiveParentId, foreignRowDetected);
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
 * a separate out-of-transaction snapshot read: a foreign process committing between this
 * transaction's commit and that later read would otherwise be silently folded into the
 * tracked snapshot without ever appearing in the caller's in-memory entries.
 *
 * The returned `effectiveParentId` mirrors TranscriptMessageAppendResult.effectiveParentId:
 * when an active-branch append's declared parentId is stale, this exposes the rebased
 * parent the append actually landed under so the caller can reconcile its in-memory tree
 * (reload) instead of trusting a divergent parentId it never observed. `foreignRowDetected`
 * signals a pendingHeader guard's row-count mismatch -- see PendingTranscriptHeader -- for
 * the id-less foreign row class that mismatch is the only detection signal for.
 */
export function appendTranscriptEventWithSnapshotSync(
  scope: SessionTranscriptWriteScope,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions = {},
  pendingHeader?: PendingTranscriptHeader,
): {
  foreignRowDetected: boolean;
  result: Result<boolean, TranscriptEventAppendError>;
  snapshot?: SqliteTranscriptSnapshotRow[];
  effectiveParentId?: string | null;
} {
  let snapshot: SqliteTranscriptSnapshotRow[] | undefined;
  let effectiveParentId: string | null | undefined;
  let foreignRowDetected = false;
  const result = appendTranscriptEventSyncCore(
    scope,
    event,
    options,
    (database, resolved, appendEffectiveParentId, appendForeignRowDetected) => {
      snapshot = readTranscriptEventRows(database, resolved.sessionId);
      effectiveParentId = appendEffectiveParentId;
      foreignRowDetected = appendForeignRowDetected;
    },
    pendingHeader,
  );
  return {
    foreignRowDetected,
    result,
    ...(snapshot ? { snapshot } : {}),
    ...(effectiveParentId !== undefined ? { effectiveParentId } : {}),
  };
}

function resolveTranscriptEventAppendParent(
  database: OpenClawAgentDatabase,
  sessionId: string,
  event: TranscriptEvent,
  options: TranscriptEventAppendOptions,
): { event: TranscriptEvent; effectiveParentId: string | null | undefined } {
  if (
    options.appendIntent !== "active-branch" ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    !("parentId" in event)
  ) {
    return { event, effectiveParentId: undefined };
  }
  const parentId = event.parentId;
  if (parentId !== null && typeof parentId !== "string") {
    return { event, effectiveParentId: undefined };
  }
  const effectiveParentId = resolveTranscriptMessageAppendParent(database, sessionId, {
    appendIntent: "active-branch",
    parentId,
  });
  return {
    event: effectiveParentId === parentId ? event : { ...event, parentId: effectiveParentId },
    effectiveParentId,
  };
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
