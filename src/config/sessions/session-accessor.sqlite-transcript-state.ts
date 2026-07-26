import { randomUUID } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { normalizeSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { deleteSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";

function createTranscriptGeneration(): string {
  return randomUUID().replaceAll("-", "");
}

/** Read the current raw transcript generation inside the caller's transaction. */
export function readTranscriptGenerationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | undefined {
  const db = getSessionKysely(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", sessionId),
  )?.generation;
}

/** Materialize a generation once; pure appends must preserve an existing token. */
export function ensureTranscriptGenerationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string {
  const db = getSessionKysely(database.db);
  const generation = createTranscriptGeneration();
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_rewrite_watermarks")
      .values({ session_id: sessionId, generation, updated_at: Date.now() })
      .onConflict((conflict) => conflict.column("session_id").doNothing()),
  );
  return readTranscriptGenerationInTransaction(database, sessionId) ?? generation;
}

/** Rotate the watermark in the same transaction as destructive transcript replacement. */
export function rotateTranscriptGenerationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string {
  const db = getSessionKysely(database.db);
  const generation = createTranscriptGeneration();
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_rewrite_watermarks")
      .values({ session_id: sessionId, generation, updated_at: Date.now() })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({ generation, updated_at: Date.now() }),
      ),
  );
  return generation;
}

export function ensureTranscriptSessionRoot(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  updatedAt: number,
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values({
        session_key: scope.sessionKey,
        current_session_id: scope.sessionId,
        entry_json: "{}",
        updated_at: updatedAt,
      })
      .onConflict((conflict) => conflict.column("session_key").doNothing()),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_windows")
      .values({
        session_id: scope.sessionId,
        session_key: scope.sessionKey,
        previous_session_id: null,
        reason: null,
        session_scope: "conversation",
        created_at: updatedAt,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: scope.sessionKey,
          updated_at: updatedAt,
        }),
      ),
  );
}

export function readNextTranscriptSeq(database: OpenClawAgentDatabase, sessionId: string): number {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number | bigint>("seq").as("max_seq"))
      .where("session_id", "=", sessionId),
  );
  const maxSeq =
    row?.max_seq === null || row?.max_seq === undefined ? -1 : normalizeSqliteNumber(row.max_seq);
  return maxSeq + 1;
}

function normalizeTranscriptMutationAtMs(value: number): number | undefined {
  const timestamp = Math.floor(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

export function readTranscriptMutationStateInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): { observedAt: number | null; updatedAt: number | null } {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["transcript_observed_at", "transcript_updated_at"])
      .where("session_id", "=", sessionId),
  );
  return {
    observedAt: row?.transcript_observed_at ?? null,
    updatedAt: row?.transcript_updated_at ?? null,
  };
}

export function advanceTranscriptMutationAtInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  value: number,
  options: { strictly?: boolean } = {},
): void {
  const transcriptUpdatedAt = normalizeTranscriptMutationAtMs(value);
  if (transcriptUpdatedAt === undefined) {
    return;
  }
  const state = readTranscriptMutationStateInTransaction(database, sessionId);
  const next = options.strictly
    ? Math.max(transcriptUpdatedAt, (state.updatedAt ?? -1) + 1, (state.observedAt ?? -1) + 1)
    : Math.max(transcriptUpdatedAt, state.updatedAt ?? 0);
  if (state.updatedAt !== null && state.updatedAt >= next) {
    return;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ transcript_updated_at: next })
      .where("session_id", "=", sessionId),
  );
}

export function touchTranscriptMutationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): void {
  const now = normalizeTranscriptMutationAtMs(Date.now());
  if (now !== undefined) {
    advanceTranscriptMutationAtInTransaction(database, sessionId, now, { strictly: true });
  }
}

export function deleteSqliteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): boolean {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("transcript_event_identities").where("session_id", "=", sessionId),
  );
  const result = executeSqliteQuerySync(
    database.db,
    db.deleteFrom("transcript_events").where("session_id", "=", sessionId),
  );
  // FTS rows have no FK onto transcript_events; clear them in this transaction.
  deleteSessionTranscriptIndexInTransaction(database.db, sessionId);
  return (result.numAffectedRows ?? 0n) > 0n;
}
