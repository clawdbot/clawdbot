import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { publishSqliteSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventJsonSetInTransaction } from "./session-accessor.sqlite-read.js";
import {
  formatSqliteSessionReferenceForScope,
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  advanceTranscriptMutationAtInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";
import {
  parseTranscriptPolicyArchive,
  restoreConfirmedTranscriptPolicyArchiveInTransaction,
} from "./session-transcript-policy-archive.js";
import type { SessionEntry } from "./types.js";

type ConfirmedTranscriptImportDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  "session_memory_subject_snapshots" | "session_memory_subjects" | "transcript_events"
>;

/** Internal doctor/migration import target for one legacy session row. */
type SqliteSessionImportRowsParams = {
  allowMalformedRowRepair?: boolean;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  preserveExactStoredKey?: boolean;
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
  transcriptEvents: number;
};

type ConfirmedSqliteTranscriptImportParams = {
  agentId?: string;
  archiveContent: string;
  entry: SessionEntry;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  storePath?: string;
};

type ConfirmedSqliteTranscriptImportResult = {
  sessionId: string;
  sessionKey: string;
  transcriptEvents: number;
};

/**
 * Internal owner flow for an operator-confirmed archive only. Legacy Doctor
 * import stays quarantined; callers must authenticate confirmation before this
 * API is reached and must not expose it as a model/runtime import surface.
 */
export async function importConfirmedSqliteTranscriptPolicyArchive(
  params: ConfirmedSqliteTranscriptImportParams,
): Promise<ConfirmedSqliteTranscriptImportResult> {
  // Archive parsing is deliberately outside the synchronous write transaction.
  const archive = parseTranscriptPolicyArchive(params.archiveContent);
  if (!archive) {
    throw new Error("confirmed transcript archive is invalid or legacy JSONL");
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.env ? { env: params.env } : {}),
    sessionKey: params.sessionKey,
    ...(params.storePath ? { storePath: params.storePath } : {}),
  });
  if (
    archive.agentId !== resolved.agentId ||
    archive.sessionId !== params.entry.sessionId ||
    archive.sessionKey !== resolved.sessionKey
  ) {
    throw new Error("confirmed transcript archive target mismatch");
  }
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let transcriptEvents = 0;
    runOpenClawAgentWriteTransaction((database) => {
      const db = getNodeSqliteKysely<ConfirmedTranscriptImportDatabase>(database.db);
      const currentEntry = readExactSessionEntryRowForCanonicalRepair(
        database,
        resolved.sessionKey,
      )?.entry;
      if (currentEntry && currentEntry.sessionId !== archive.sessionId) {
        throw new Error("confirmed transcript archive would replace an active session");
      }
      const subject = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_memory_subjects")
          .select("subject_revision")
          .where("session_key", "=", resolved.sessionKey)
          .limit(1),
      );
      if (!subject || subject.subject_revision !== archive.subjectRevision) {
        throw new Error("confirmed transcript archive subject is unavailable");
      }
      const snapshotBeforeRestore = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_memory_subject_snapshots")
          .select(["session_identity_revision", "session_key", "subject_revision"])
          .where("session_id", "=", archive.sessionId)
          .limit(1),
      );
      if (
        snapshotBeforeRestore &&
        (snapshotBeforeRestore.session_key !== archive.sessionKey ||
          snapshotBeforeRestore.subject_revision !== archive.subjectRevision ||
          snapshotBeforeRestore.session_identity_revision !== archive.sessionIdentityRevision)
      ) {
        throw new Error("confirmed transcript archive immutable snapshot conflicts");
      }
      const existingEvents = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", archive.sessionId),
      ).rows;
      if (existingEvents.length > 0) {
        throw new Error("confirmed transcript archive target already has transcript events");
      }

      writeSessionEntry(database, resolved.sessionKey, params.entry, {
        previousEntry: currentEntry ?? null,
      });
      // writeSessionEntry snapshots the surviving immutable subject. Replace only
      // that just-created snapshot with the archive's proven generation identity.
      if (!snapshotBeforeRestore) {
        executeSqliteQuerySync(
          database.db,
          db
            .deleteFrom("session_memory_subject_snapshots")
            .where("session_id", "=", archive.sessionId),
        );
        executeSqliteQuerySync(
          database.db,
          db.insertInto("session_memory_subject_snapshots").values({
            session_id: archive.sessionId,
            session_key: archive.sessionKey,
            subject_revision: archive.subjectRevision,
            session_identity_revision: archive.sessionIdentityRevision,
            created_at: Date.now(),
          }),
        );
      }

      const transcriptScope = { ...resolved, sessionId: archive.sessionId };
      for (const archived of archive.events) {
        if (
          !appendTranscriptEventInTransaction(database, transcriptScope, archived.event, {
            scheduleProjectionReconcile: false,
            touchMutation: false,
          })
        ) {
          throw new Error("confirmed transcript archive event append conflict");
        }
        transcriptEvents += 1;
      }
      restoreConfirmedTranscriptPolicyArchiveInTransaction({
        archive,
        database,
        sessionId: archive.sessionId,
        sessionKey: archive.sessionKey,
      });
      reconcileSessionTranscriptIndexInTransaction(database.db, archive.sessionId);
      touchTranscriptMutationInTransaction(database, archive.sessionId);
      publishSqliteSessionEntryCacheInvalidation(database);
    }, toDatabaseOptions(resolved));
    return {
      sessionId: archive.sessionId,
      sessionKey: resolved.sessionKey,
      transcriptEvents,
    };
  });
}

/** Imports one legacy session entry and its transcript rows for doctor migration. */
export async function importSqliteSessionRows(
  params: SqliteSessionImportRowsParams,
): Promise<SqliteSessionImportRowsResult> {
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
        memorySubjectImportQuarantine: true,
        previousEntry: currentEntry ?? null,
      });
      if (params.readTranscriptEvents) {
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
        publishSqliteSessionEntryCacheInvalidation(database);
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
      transcriptEvents,
    };
  });
}
