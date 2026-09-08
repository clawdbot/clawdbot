import { randomUUID } from "node:crypto";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  assertCanonicalSessionKeyWriteMatchesDatabase,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import {
  foldedSessionKeyAliasCandidates,
  normalizeStoreSessionKey,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";

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
  options: { allowStoredAlias?: boolean } = {},
): void {
  const db = getSessionKysely(database.db);
  if (!options.allowStoredAlias) {
    assertCanonicalSqliteSessionKeysCurrent(database);
    assertCanonicalSessionKeyWriteMatchesDatabase(database, scope.sessionKey);
    const persistedSessionKey = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_windows")
        .select("session_key")
        .where("session_id", "=", scope.sessionId),
    )?.session_key;
    if (persistedSessionKey && persistedSessionKey !== scope.sessionKey) {
      throw new Error(
        `Transcript session ${scope.sessionId} is owned by ${persistedSessionKey}, not ${scope.sessionKey}; resolve the transcript target again before retrying.`,
      );
    }
    const lookupKeys = uniqueStrings([
      scope.sessionKey,
      ...foldedSessionKeyAliasCandidates(normalizeStoreSessionKey(scope.sessionKey)),
    ]);
    const candidates = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select(["current_session_id", "entry_json", "entry_valid", "session_key", "updated_at"])
        .where("session_key", "in", lookupKeys),
    ).rows;
    for (const candidate of candidates) {
      const entry = parseSessionEntryJson(candidate);
      if (!entry) {
        const retainedWindow =
          candidate.entry_json === "{}"
            ? executeSqliteQueryTakeFirstSync(
                database.db,
                db
                  .selectFrom("session_windows")
                  .select("session_id")
                  .where("session_id", "=", candidate.current_session_id)
                  .where("session_key", "=", candidate.session_key),
              )
            : undefined;
        if (!retainedWindow) {
          throw canonicalSessionKeyMigrationRequiredError(
            `invalid persisted session row requires repair for ${candidate.session_key}`,
          );
        }
        continue;
      }
      if (
        resolveDeliveryProvenCanonicalSessionKey(candidate.session_key, entry) !==
        candidate.session_key
      ) {
        throw canonicalSessionKeyMigrationRequiredError(
          `non-canonical persisted row resolves to session key ${candidate.session_key}`,
        );
      }
    }
    const existing = candidates.find((candidate) => candidate.session_key === scope.sessionKey);
    if (existing && existing.entry_valid !== 1) {
      const retainedWindow =
        existing.entry_json === "{}"
          ? executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("session_windows")
                .select("session_id")
                .where("session_id", "=", existing.current_session_id)
                .where("session_key", "=", scope.sessionKey),
            )
          : undefined;
      if (!retainedWindow) {
        throw canonicalSessionKeyMigrationRequiredError(
          `invalid persisted session row requires repair for ${scope.sessionKey}`,
        );
      }
    }
  }
  const insertedNode = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values({
        session_key: scope.sessionKey,
        current_session_id: scope.sessionId,
        entry_json: "{}",
        entry_valid: -1,
        updated_at: updatedAt,
      })
      .onConflict((conflict) => conflict.column("session_key").doNothing()),
  );
  if ((insertedNode.numAffectedRows ?? 0n) > 0n) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({ entry_valid: -1 })
        .where("session_key", "=", scope.sessionKey),
    );
    publishSessionEntryCacheInvalidation(database);
  }
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
    row?.max_seq === null || row?.max_seq === undefined ? -1 : sqliteNumber(row.max_seq);
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

export function deleteTranscriptEventsInTransaction(
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
  return (result.numAffectedRows ?? 0n) > 0n;
}
