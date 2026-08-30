import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import {
  runOpenClawAgentWriteTransaction,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import type { SessionAccessScope, TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import {
  withSqliteSessionImportStage,
  type SqliteSessionImportStage,
} from "./session-accessor.sqlite-import-stage.js";
import { replaceSessionOwnerInTransaction } from "./session-accessor.sqlite-owner.js";
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
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import type { SessionEntry } from "./types.js";

/** Internal doctor/migration import target for one legacy session row. */
type SqliteSessionImportRowsParams = Pick<
  SessionAccessScope,
  "agentId" | "defaultAgentId" | "env" | "sessionKey" | "storePath"
> & {
  allowMalformedRowRepair?: boolean;
  preserveExactStoredKey?: boolean;
  readExactTranscriptRows?: (
    append: (row: { createdAt: number; eventJson: string }) => void,
  ) => void;
  skipIfExists?: boolean;
  entry: SessionEntry;
  readTranscriptEvents?: (append: (event: TranscriptEvent) => void) => void | (() => void);
  transcriptMtimeMs?: number;
};

/** Summary of rows written by an internal doctor/migration import. */
type SqliteSessionImportRowsResult = {
  sessionId: string;
  sessionKey: string;
  skippedExisting?: true;
  transcriptEvents: number;
};

function resolveSqliteSessionImport(params: SqliteSessionImportRowsParams) {
  if (params.readExactTranscriptRows && params.readTranscriptEvents) {
    throw new Error("SQLite session import accepts only one transcript row source");
  }
  const resolvedScope = resolveSqliteScope(params);
  // Doctor can stage the exact legacy key so canonical repair compares every alias candidate.
  const resolved = params.preserveExactStoredKey
    ? { ...resolvedScope, sessionKey: params.sessionKey }
    : resolvedScope;
  return { params, resolved };
}

function importSqliteSessionRowsInTransaction(
  database: OpenClawAgentDatabase,
  prepared: ReturnType<typeof resolveSqliteSessionImport>,
  stage: SqliteSessionImportStage,
  source: number,
): SqliteSessionImportRowsResult {
  const { params, resolved } = prepared;
  let transcriptEvents = 0;
  // Doctor may have staged another legacy alias in this database already. Inspect only this
  // exact import target; runtime-wide canonical validation runs after the import phase.
  const currentEntry = readExactSessionEntryRowForCanonicalRepair(database, resolved.sessionKey, {
    allowMalformedRowRepair: params.allowMalformedRowRepair === true,
  })?.entry;
  if (params.skipIfExists === true && currentEntry) {
    return {
      sessionId: params.entry.sessionId,
      sessionKey: resolved.sessionKey,
      skippedExisting: true,
      transcriptEvents,
    };
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
  // Only trusted SQLite handoffs can transfer ownership and hash exact ordered rows;
  // parsing, deduping, or trusting JSON ownership would break the migration boundary.
  if (params.readExactTranscriptRows) {
    replaceSessionOwnerInTransaction(database, resolved.sessionKey, params.entry.owner);
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
      for (const row of stage.rows(source)) {
        if (row.seq === 0) {
          ensureTranscriptSessionRoot(database, transcriptScope, row.createdAt!, {
            allowStoredAlias: true,
          });
          ensureTranscriptGenerationInTransaction(database, params.entry.sessionId);
        }
        executeSqliteQuerySync(
          database.db,
          db.insertInto("transcript_events").values({
            session_id: params.entry.sessionId,
            seq: row.seq,
            event_json: row.eventJson,
            created_at: row.createdAt!,
          }),
        );
        transcriptEvents += 1;
      }
      // Doctor imports run outside gateway requests and must finish with a complete projection.
      reconcileSessionTranscriptIndexInTransaction(database.db, params.entry.sessionId);
      publishSessionEntryCacheInvalidation(database);
    }
  } else if (params.readTranscriptEvents) {
    const transcriptScope = {
      ...resolved,
      sessionId: params.entry.sessionId,
    };
    stage.resetSeen();
    for (const row of iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select("event_json")
        .where("session_id", "=", params.entry.sessionId),
    )) {
      stage.addSeen(row.event_json);
    }
    transcriptEvents = appendTranscriptEventsInTransaction(
      database,
      transcriptScope,
      (function* (): Generator<TranscriptEvent, void, boolean> {
        for (const row of stage.rows(source)) {
          if (stage.hasSeen(row.eventJson)) {
            continue;
          }
          // SAFETY: staging serialized the caller's TranscriptEvent without transforming its contents.
          const inserted = yield JSON.parse(row.eventJson) as TranscriptEvent;
          if (inserted) {
            stage.addSeen(row.eventJson);
          }
        }
      })(),
      { allowStoredAlias: true, scheduleProjectionReconcile: false, touchMutation: false },
    );
    // Doctor imports run outside gateway requests and must finish with a complete projection.
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
  return {
    sessionId: params.entry.sessionId,
    sessionKey: resolved.sessionKey,
    transcriptEvents,
  };
}

/** Imports legacy session rows that share one SQLite store in one durable transaction. */
export async function importSqliteSessionRowsBatch(
  params: readonly SqliteSessionImportRowsParams[],
): Promise<SqliteSessionImportRowsResult[]> {
  if (params.length === 0) {
    return [];
  }
  const prepared = params.map(resolveSqliteSessionImport);
  const resolved = prepared[0]!.resolved;
  const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved));
  if (
    prepared.some(
      (row) => resolveOpenClawAgentSqlitePath(toDatabaseOptions(row.resolved)) !== databasePath,
    )
  ) {
    throw new Error("SQLite session import batch spans multiple stores");
  }
  return await runExclusiveSqliteSessionWrite(resolved, async () =>
    withSqliteSessionImportStage((stage) => {
      const validators: Array<() => void> = [];
      for (const [source, { params: importParams }] of prepared.entries()) {
        let seq = 0;
        importParams.readExactTranscriptRows?.((row) =>
          stage.append(source, seq++, row.eventJson, row.createdAt),
        );
        const validate = importParams.readTranscriptEvents?.((event) =>
          stage.append(source, seq++, JSON.stringify(event), null),
        );
        if (validate) {
          validators.push(validate);
        }
      }
      // Recheck every source after the last reader, before any canonical transaction.
      // No filesystem readers or callbacks cross the synchronous SQLite commit boundary.
      for (const validate of validators) {
        validate();
      }
      return runOpenClawAgentWriteTransaction(
        (database) =>
          prepared.map((row, source) =>
            importSqliteSessionRowsInTransaction(database, row, stage, source),
          ),
        toDatabaseOptions(resolved),
      );
    }),
  );
}

/** Imports one legacy session entry and its transcript rows for doctor migration. */
export async function importSqliteSessionRows(
  params: SqliteSessionImportRowsParams,
): Promise<SqliteSessionImportRowsResult> {
  return (await importSqliteSessionRowsBatch([params]))[0]!;
}
