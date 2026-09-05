import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readNextTranscriptSeq,
  readTranscriptGenerationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  claimStagedTranscriptIdempotencyKeysInTransaction,
  redactTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

type TranscriptRewriteNavigationState = {
  appendMode?: "side";
  appendParentId: string | null;
  leafId: string | null;
};

class TranscriptRewriteConflictError extends Error {
  constructor(sessionId: string) {
    super(`SQLite transcript changed while preparing rewrite for ${sessionId}`);
    this.name = "TranscriptRewriteConflictError";
  }
}

/** Stages a successor branch in bounded commits, then publishes its leaf atomically. */
export function publishTranscriptRewriteSync(
  scope: SessionTranscriptWriteScope,
  params: {
    active: TranscriptRewriteNavigationState;
    entries: readonly TranscriptEvent[];
    expectedEvents: readonly TranscriptEvent[];
    finalLeafId: string;
  },
): Result<boolean, TranscriptAppendRefusal> {
  if (params.entries.length === 0) {
    return ok(false);
  }
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let expectedGeneration: string | null | undefined;
  let expectedNextSeq: number | undefined;
  let result: Result<boolean, TranscriptAppendRefusal> = ok(false);

  for (const [index, entry] of params.entries.entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      throw new Error("Invalid staged transcript rewrite entry");
    }
    const entryId = entry.id;
    const isFinalEntry = index === params.entries.length - 1;
    runOpenClawAgentWriteTransaction((database) => {
      assertOwnedTranscriptWriteCommit(fencedScope);
      const fresh = readSessionEntryRow(database, resolved.sessionKey);
      const refusal = resolveTranscriptAppendRefusal(fresh?.entry, resolved, fencedScope);
      if (refusal) {
        result = err(refusal);
        return;
      }
      const generation =
        readTranscriptGenerationInTransaction(database, resolved.sessionId) ?? null;
      const nextSeq = readNextTranscriptSeq(database, resolved.sessionId);
      if (index === 0) {
        const rows = readTranscriptEventRows(database, resolved.sessionId);
        const unchanged =
          rows.length === params.expectedEvents.length &&
          rows.every(
            (row, rowIndex) => row.eventJson === JSON.stringify(params.expectedEvents[rowIndex]),
          );
        if (!unchanged) {
          throw new TranscriptRewriteConflictError(resolved.sessionId);
        }
        expectedGeneration = generation;
        expectedNextSeq = nextSeq;
      } else if (generation !== expectedGeneration || nextSeq !== expectedNextSeq) {
        throw new TranscriptRewriteConflictError(resolved.sessionId);
      }

      const stagedEntry =
        entry.type === "message"
          ? { ...entry, message: redactTranscriptMessageForStorage(entry.message, {}) }
          : entry;
      if (
        !appendTranscriptEventInTransaction(database, resolved, stagedEntry, {
          idempotencyKeyMode: "stage",
          scheduleProjectionReconcile: false,
        })
      ) {
        throw new Error(`Staged transcript rewrite entry was not persisted: ${entryId}`);
      }
      const nextState = isFinalEntry
        ? { appendParentId: params.finalLeafId, leafId: params.finalLeafId }
        : params.active;
      const leafControl = {
        type: "leaf",
        id: randomUUID(),
        parentId: entryId,
        timestamp: new Date().toISOString(),
        targetId: nextState.leafId,
        ...(nextState.appendParentId !== nextState.leafId
          ? { appendParentId: nextState.appendParentId }
          : {}),
        ...(nextState.appendMode ? { appendMode: nextState.appendMode } : {}),
      };
      if (isFinalEntry) {
        claimStagedTranscriptIdempotencyKeysInTransaction(
          database,
          resolved.sessionId,
          params.entries,
        );
      }
      if (
        !appendTranscriptEventInTransaction(database, resolved, leafControl, {
          scheduleProjectionReconcile: isFinalEntry,
        })
      ) {
        throw new Error("Transcript rewrite leaf was not persisted");
      }
      assertOwnedTranscriptWriteCommit(fencedScope);
      expectedNextSeq = nextSeq + 2;
      result = ok(true);
    }, toDatabaseOptions(resolved));
    if (!result.ok) {
      break;
    }
  }
  if (fencedScope.expectedWriterRunId !== undefined && !result.ok) {
    throw new SessionTranscriptWriterClaimReboundError(result.error);
  }
  return result;
}
