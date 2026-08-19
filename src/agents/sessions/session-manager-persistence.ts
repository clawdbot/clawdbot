import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  appendTranscriptEventSync,
  appendTranscriptEventWithSnapshotSync,
  appendTranscriptMessageWithSnapshotSync,
  ensureSessionEntrySync,
  type PendingTranscriptHeader,
  SqliteTranscriptMutationConflictError,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry, parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import type { AppendPersistenceOptions, SessionEntry } from "./session-manager-types.js";

type PersistRecordResult =
  | string
  | null
  | undefined
  | {
      anchor?: TranscriptEntryAnchor;
      adoptedMessageId?: string;
      effectiveParentId: string | null;
      foreignRowDetected?: boolean;
    };

function requireTranscriptEventAppend(
  result: ReturnType<typeof appendTranscriptEventSync>,
  message: string,
): void {
  if (result.ok && result.value) {
    return;
  }
  const cause = result.ok ? { code: "transcript-event-not-appended" as const } : result.error;
  throw new Error(`${message}: ${cause.code}`, { cause });
}

export class SessionManagerPersistence extends SessionManagerCore {
  removeTrailingEntries(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): number {
    let preservedStart = this.fileEntries.length;
    while (preservedStart > 1) {
      const entry = this.fileEntries[preservedStart - 1];
      if (!isIndexedSessionEntry(entry) || !options?.preserveTrailing?.(entry)) {
        break;
      }
      preservedStart -= 1;
    }

    let removeStart = preservedStart;
    while (removeStart > 1) {
      const entry = this.fileEntries[removeStart - 1];
      if (!isIndexedSessionEntry(entry) || !predicate(entry)) {
        break;
      }
      removeStart -= 1;
    }
    if (removeStart === preservedStart) {
      return 0;
    }

    const shiftOpaqueIndexesAfterRemoval = (start: number, count: number): void => {
      for (const opaqueEntry of this.opaqueFileEntries) {
        const removedBeforeOpaque = Math.max(0, Math.min(count, opaqueEntry.index - start));
        opaqueEntry.index -= removedBeforeOpaque;
      }
    };
    const removedCount = preservedStart - removeStart;
    shiftOpaqueIndexesAfterRemoval(removeStart, removedCount);
    const removedEntries = this.fileEntries.splice(removeStart, removedCount) as SessionEntry[];
    const removedParentById = new Map(
      removedEntries.map((entry) => [entry.id, entry.parentId] as const),
    );
    for (let index = removeStart; index < this.fileEntries.length;) {
      const entry = this.fileEntries[index];
      if (
        isIndexedSessionEntry(entry) &&
        entry.type === "label" &&
        removedParentById.has(entry.targetId)
      ) {
        removedParentById.set(entry.id, entry.parentId);
        shiftOpaqueIndexesAfterRemoval(index, 1);
        this.fileEntries.splice(index, 1);
        continue;
      }
      index += 1;
    }

    const resolveRetainedParentId = (parentId: string | null): string | null => {
      const seen = new Set<string>();
      let currentId = parentId;
      while (currentId && removedParentById.has(currentId) && !seen.has(currentId)) {
        seen.add(currentId);
        currentId = removedParentById.get(currentId) ?? null;
      }
      return currentId;
    };
    const replacementParentId = resolveRetainedParentId(removedEntries[0]?.parentId ?? null);
    this.fileEntries = this.fileEntries.map((entry) => {
      if (!isIndexedSessionEntry(entry)) {
        return entry;
      }
      const parentId = resolveRetainedParentId(entry.parentId);
      return parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry);
    });
    this.opaqueFileEntries = this.opaqueFileEntries.map((opaqueEntry) => {
      if (!isRecord(opaqueEntry.record)) {
        return opaqueEntry;
      }
      const record = opaqueEntry.record;
      const parentId =
        record.parentId === null || typeof record.parentId === "string"
          ? resolveRetainedParentId(record.parentId)
          : undefined;
      const leafEntry = parseOpaqueLeafEntry(record);
      const targetId = leafEntry ? resolveRetainedParentId(leafEntry.targetId) : undefined;
      const appendParentId =
        leafEntry?.appendParentId !== undefined
          ? resolveRetainedParentId(leafEntry.appendParentId)
          : undefined;
      if (
        (parentId === undefined || parentId === record.parentId) &&
        (targetId === undefined || targetId === leafEntry?.targetId) &&
        (appendParentId === undefined || appendParentId === leafEntry?.appendParentId)
      ) {
        return opaqueEntry;
      }
      return {
        ...opaqueEntry,
        record: {
          ...record,
          ...(parentId !== undefined ? { parentId } : {}),
          ...(targetId !== undefined ? { targetId } : {}),
          ...(appendParentId !== undefined ? { appendParentId } : {}),
        },
      };
    });

    this.clampOpaqueFileEntryIndexes();
    this.buildIndex();
    this.leafId = this.resolveCanonicalParentId(replacementParentId);
    this.appendParentId = replacementParentId;
    this.replacePersistedTranscript();
    return removedEntries.length;
  }

  protected persistRecord(entry: unknown, options?: AppendPersistenceOptions): PersistRecordResult {
    if (this.persistenceTarget) {
      return this.persistSqliteRecord(entry, options);
    }
    return undefined;
  }

  persist(entry: SessionEntry, options?: AppendPersistenceOptions): PersistRecordResult {
    return this.persistRecord(entry, options);
  }

  /**
   * Ensures the deferred session_entries row exists (separate table from transcript_events, so
   * outside the folded snapshot guard) before the append cores, which no-op when it is missing,
   * then returns the still-pending header transcript row to fold into the first record's
   * transaction. Returns undefined once a header is already persisted.
   */
  private resolveDeferredSessionHeader(
    scope: NonNullable<SessionManagerPersistence["persistenceTarget"]>,
  ): PendingTranscriptHeader["event"] {
    if (!this.persistenceHeaderPending) {
      return undefined;
    }
    if (!ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: Date.now() })) {
      throw new Error("Session transcript header was not persisted");
    }
    const header = this.fileEntries[0];
    if (!header || header.type !== "session") {
      throw new Error("Session transcript header was not persisted");
    }
    return header;
  }

  /**
   * Snapshot guard for one record append, folding a still-deferred header when pending. Once a
   * header exists, active-branch appends (the tail-rebase path in the append core) reconcile a
   * concurrent *identity-tracked* foreign row via `effectiveParentId` -- appendEntry detects the
   * mismatch and reloads. But that rebase reads transcript_event_identities, so it cannot see a
   * foreign row with no non-blank `id` (e.g. an msteams FeedbackEvent never gets an identities
   * row) -- such a row never moves the tail, so no mismatch is ever detected and a later rewrite
   * built from this manager's contaminated snapshot would delete it. Guard active-branch appends
   * too, but non-throwing (see PendingTranscriptHeader.nonThrowing): the caller folds a detected
   * mismatch into a reload instead of a hard rejection, preserving the graceful-rebase intent for
   * every concurrent active-branch writer. Side-mode, deliberate-branch (post-branch/resetLeaf),
   * and leaf-control appends keep their exact declared parent and never rebase, so a throwing
   * guard is their only foreign-row signal.
   */
  private resolveAppendGuard(
    scope: NonNullable<SessionManagerPersistence["persistenceTarget"]>,
    isActiveBranchAppend: boolean,
  ): PendingTranscriptHeader {
    const event = this.resolveDeferredSessionHeader(scope);
    if (event) {
      return { event, expectedSnapshot: this.persistedRowSnapshot ?? [] };
    }
    return {
      expectedSnapshot: this.persistedRowSnapshot ?? [],
      ...(isActiveBranchAppend ? { nonThrowing: true } : {}),
    };
  }

  // A guard folding a still-deferred header commits it in the same transaction as this
  // append, so once that append succeeds the header is no longer pending -- every other
  // header-persisting path (replacePersistedTranscript, branch()) clears this the same way.
  // Skipping this leaves persistenceHeaderPending stuck true, so every later append keeps
  // taking the guarded "deferred header" branch above instead of an active-branch append's
  // intended unguarded tail-rebase path, turning a graceful rebase into a hard rejection.
  private clearHeaderPendingAfterFold(guard: PendingTranscriptHeader): void {
    if (guard.event) {
      this.persistenceHeaderPending = false;
    }
  }

  private persistSqliteRecord(
    entry: unknown,
    options?: AppendPersistenceOptions,
  ): PersistRecordResult {
    if (!this.persistenceTarget) {
      return undefined;
    }
    const scope = this.persistenceTarget;
    try {
      return this.persistSqliteRecordWithGuard(scope, entry, options);
    } catch (err) {
      if (err instanceof SqliteTranscriptMutationConflictError) {
        // Durable state has moved past what this manager observed. Resync in-memory state from
        // the authoritative DB before the failure surfaces, so the caller's next read (and any
        // retry) reflects reality instead of a rejected, now-stale append.
        this.reloadPersistedTranscript();
      }
      throw err;
    }
  }

  private persistSqliteRecordWithGuard(
    scope: NonNullable<SessionManagerPersistence["persistenceTarget"]>,
    entry: unknown,
    options: AppendPersistenceOptions | undefined,
  ): PersistRecordResult {
    const leafEntry = parseOpaqueLeafEntry(entry);
    if (leafEntry) {
      const guard = this.resolveAppendGuard(scope, false);
      const { result, snapshot } = appendTranscriptEventWithSnapshotSync(
        scope,
        entry,
        undefined,
        guard,
      );
      requireTranscriptEventAppend(
        result,
        `Session transcript leaf control was not persisted: ${leafEntry.id}`,
      );
      this.applyPersistedRowSnapshot(snapshot);
      this.clearHeaderPendingAfterFold(guard);
      return undefined;
    }
    if (!isIndexedSessionEntry(entry)) {
      return undefined;
    }
    if (entry.type !== "message") {
      const isActiveBranchAppend = options?.appendIntent === "active-branch";
      const guard = this.resolveAppendGuard(scope, isActiveBranchAppend);
      const { result, snapshot, effectiveParentId, foreignRowDetected } =
        appendTranscriptEventWithSnapshotSync(
          scope,
          entry,
          isActiveBranchAppend ? { appendIntent: options.appendIntent } : undefined,
          guard,
        );
      requireTranscriptEventAppend(
        result,
        `Session transcript entry was not persisted: ${entry.id}`,
      );
      this.applyPersistedRowSnapshot(snapshot);
      this.clearHeaderPendingAfterFold(guard);
      // Raw appends rebase the same way message appends do (active-branch tail rebase),
      // but only messages returned that rebase to the caller until now. Surfacing it here
      // lets appendEntry's existing effectiveParentId check reload when a concurrent
      // foreign row moved the tail out from under this entry's declared parentId, instead
      // of trusting a stale in-memory parent a later rewrite could silently drop.
      // foreignRowDetected additionally covers the id-less row class that rebase alone
      // cannot see -- see resolveAppendGuard.
      if (effectiveParentId === undefined && !foreignRowDetected) {
        return undefined;
      }
      return {
        effectiveParentId: effectiveParentId ?? entry.parentId,
        ...(foreignRowDetected ? { foreignRowDetected } : {}),
      };
    }
    const appendOptions = {
      cwd: this.cwd,
      eventId: entry.id,
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
      message: entry.message,
      now: Date.parse(entry.timestamp),
      parentId: entry.parentId,
      ...(options?.appendIntent === "active-branch" ? { appendIntent: options.appendIntent } : {}),
    } satisfies Parameters<typeof appendTranscriptMessageWithSnapshotSync>[1];
    const messageGuard = this.resolveAppendGuard(scope, options?.appendIntent === "active-branch");
    const { result, snapshot, foreignRowDetected } = appendTranscriptMessageWithSnapshotSync(
      scope,
      appendOptions,
      messageGuard,
    );
    if (!result) {
      throw new Error(`Session transcript message was not persisted: ${entry.id}`);
    }
    this.applyPersistedRowSnapshot(snapshot);
    this.clearHeaderPendingAfterFold(messageGuard);
    if (result.messageId !== entry.id) {
      const idempotencyKey =
        entry.message.role === "user" &&
        "idempotencyKey" in entry.message &&
        typeof entry.message.idempotencyKey === "string" &&
        entry.message.idempotencyKey.length > 0
          ? entry.message.idempotencyKey
          : undefined;
      if (idempotencyKey && options?.idempotencyLookup !== "caller-checked") {
        // Ingress can commit the keyed user after this manager loaded. The
        // caller reloads and adopts only when that canonical row is still active.
        if (!result.anchor) {
          throw new Error(`Session transcript anchor was not returned: ${result.messageId}`);
        }
        return {
          adoptedMessageId: result.messageId,
          anchor: result.anchor,
          effectiveParentId: result.effectiveParentId ?? null,
        };
      }
      throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
    }
    if (
      options?.idempotencyLookup === "caller-checked" &&
      (!result?.appended || result.messageId !== entry.id)
    ) {
      throw new Error(`Session transcript append was not persisted: ${entry.id}`);
    }
    if (result.effectiveParentId === undefined) {
      throw new Error(`Session transcript append parent was not returned: ${entry.id}`);
    }
    return {
      ...(result.anchor ? { anchor: result.anchor } : {}),
      effectiveParentId: result.effectiveParentId,
      ...(foreignRowDetected ? { foreignRowDetected } : {}),
    };
  }
}
