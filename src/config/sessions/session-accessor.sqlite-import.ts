import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventJsonSetInTransaction } from "./session-accessor.sqlite-read.js";
import {
  formatSqliteSessionReferenceForScope,
  getSessionKysely,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  advanceTranscriptMutationAtInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type { SessionEntry } from "./types.js";

/** Internal doctor/migration import target for one legacy session row. */
type SqliteSessionImportRowsParams = {
  allowMalformedRowRepair?: boolean;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  preserveExactStoredKey?: boolean;
  readExactTranscriptRows?: (
    append: (row: { createdAt: number; eventJson: string }) => void,
  ) => void;
  skipIfExists?: boolean;
  storePath?: string;
  sessionKey: string;
  entry: SessionEntry;
  readTranscriptEvents?: (append: (event: TranscriptEvent) => void) => void;
  transcriptMtimeMs?: number;
};

/** Summary of rows written by an internal doctor/migration import. */
type SqliteSessionImportRowsResult = {
  sessionId: string;
  sessionKey: string;
  skippedExisting?: true;
  transcriptEvents: number;
};

/** Imports one legacy session entry and its transcript rows for doctor migration. */
export async function importSqliteSessionRows(
  params: SqliteSessionImportRowsParams,
): Promise<SqliteSessionImportRowsResult> {
  if (params.readExactTranscriptRows && params.readTranscriptEvents) {
    throw new Error("SQLite session import accepts only one transcript row source");
  }
  const resolvedScope = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: params.sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  // Doctor can stage the exact legacy key so canonical repair compares every alias candidate.
  const resolved = params.preserveExactStoredKey
    ? { ...resolvedScope, sessionKey: params.sessionKey }
    : resolvedScope;
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let transcriptEvents = 0;
    let skippedExisting = false;
    runOpenClawAgentWriteTransaction((database) => {
      // Doctor may have staged another legacy alias in this database already. Inspect only this
      // exact import target; runtime-wide canonical validation runs after the import phase.
      const currentEntry = readExactSessionEntryRowForCanonicalRepair(
        database,
        resolved.sessionKey,
        {
          allowMalformedRowRepair: params.allowMalformedRowRepair === true,
        },
      )?.entry;
      if (params.skipIfExists === true && currentEntry) {
        skippedExisting = true;
        return;
      }
      const preservedHarnessId =
        params.entry.agentHarnessId === undefined &&
        currentEntry?.sessionId === params.entry.sessionId &&
        currentEntry.lifecycleRevision === params.entry.lifecycleRevision
          ? currentEntry.agentHarnessId?.trim()
          : undefined;
      // Plugin doctor migrations can claim a legacy session before the full
      // session import runs. Preserve that same-generation canonical owner.
      const importedEntry = {
        ...params.entry,
        ...(preservedHarnessId ? { agentHarnessId: preservedHarnessId } : {}),
        sessionFile: formatSqliteSessionReferenceForScope({
          ...resolved,
          sessionId: params.entry.sessionId,
        }),
      };
      // Doctor imports legacy aliases verbatim; canonical-key repair owns their normalization.
      writeSessionEntry(database, resolved.sessionKey, importedEntry, {
        allowStoredAliases: true,
        previousEntry: currentEntry ?? null,
      });
      // The legacy-main handoff hashes raw ordered rows. Parsing or deduping here would make the
      // destination proof differ and strand a partially imported canonical claim.
      if (params.readExactTranscriptRows) {
        const transcriptScope = {
          ...resolved,
          sessionId: params.entry.sessionId,
        };
        const db = getSessionKysely(database.db);
        const existing = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_events")
            .select("seq")
            .where("session_id", "=", params.entry.sessionId)
            .limit(1),
        );
        if (!existing) {
          const rows: Array<{ createdAt: number; eventJson: string }> = [];
          params.readExactTranscriptRows((row) => rows.push(row));
          if (rows.length > 0) {
            ensureTranscriptSessionRoot(database, transcriptScope, rows[0]!.createdAt, {
              allowStoredAlias: true,
            });
            ensureTranscriptGenerationInTransaction(database, params.entry.sessionId);
            for (const [seq, row] of rows.entries()) {
              executeSqliteQuerySync(
                database.db,
                db.insertInto("transcript_events").values({
                  session_id: params.entry.sessionId,
                  seq,
                  event_json: row.eventJson,
                  created_at: row.createdAt,
                }),
              );
            }
            transcriptEvents = rows.length;
            reconcileSessionTranscriptIndexInTransaction(database.db, params.entry.sessionId);
            publishSessionEntryCacheInvalidation(database);
          }
        }
      } else if (params.readTranscriptEvents) {
        const transcriptScope = {
          ...resolved,
          sessionId: params.entry.sessionId,
        };
        const existingEventJson = readTranscriptEventJsonSetInTransaction(
          database,
          params.entry.sessionId,
        );
        params.readTranscriptEvents((event) => {
          const eventJson = JSON.stringify(event);
          if (existingEventJson.has(eventJson)) {
            return;
          }
          if (
            appendTranscriptEventInTransaction(database, transcriptScope, event, {
              allowStoredAlias: true,
              scheduleProjectionReconcile: false,
              touchMutation: false,
            })
          ) {
            existingEventJson.add(eventJson);
            transcriptEvents += 1;
          }
        });
        reconcileSessionTranscriptIndexInTransaction(database.db, params.entry.sessionId);
        publishSessionEntryCacheInvalidation(database);
      }
      if (params.transcriptMtimeMs !== undefined) {
        advanceTranscriptMutationAtInTransaction(
          database,
          params.entry.sessionId,
          params.transcriptMtimeMs,
        );
      } else if (transcriptEvents > 0) {
        touchTranscriptMutationInTransaction(database, params.entry.sessionId);
      }
    }, toDatabaseOptions(resolved));
    return {
      sessionId: params.entry.sessionId,
      sessionKey: resolved.sessionKey,
      ...(skippedExisting ? { skippedExisting: true as const } : {}),
      transcriptEvents,
    };
  });
}
