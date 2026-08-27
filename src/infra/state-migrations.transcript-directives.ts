import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "../state/openclaw-agent-db-maintenance.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { resolveAgentDatabaseMigrationTargets } from "./state-migrations.media-persistence-targets.js";
import {
  migrateTranscriptDirectiveArchives,
  TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE,
} from "./state-migrations.transcript-directives-archives.js";
import { transformHistoricalTranscriptEvent } from "./state-migrations.transcript-directives-transform.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const MIGRATION_META_KEY = "historical-transcript-directives-v1";

type TranscriptDirectiveMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "transcript_events"
>;

type MigrationCursor =
  | { phase: "transcripts"; sessionId: string }
  | { generation: string; phase: "archives"; sessionId: string }
  | { phase: "complete" };

type TranscriptRowPlan = {
  eventJson: string;
  rewrittenEventJson: string;
  seq: number;
};

type DatabaseMigrationResult = {
  archivedTranscripts: number;
  transcriptSessions: number;
};

function createMigrationDatabaseHandle(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
): OpenClawAgentDatabase {
  return {
    agentId,
    db: database,
    path: pathname,
    walMaintenance: { checkpoint: () => false, close: () => false },
  };
}

function parseMigrationCursor(value: string | null | undefined, pathname: string): MigrationCursor {
  if (!value) {
    return { phase: "transcripts", sessionId: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${pathname} has an invalid historical transcript migration cursor`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${pathname} has an invalid historical transcript migration cursor`);
  }
  if (parsed.phase === "complete") {
    return { phase: "complete" };
  }
  if (parsed.phase === "transcripts" && typeof parsed.sessionId === "string") {
    return { phase: "transcripts", sessionId: parsed.sessionId };
  }
  if (
    parsed.phase === "archives" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.generation === "string"
  ) {
    return {
      generation: parsed.generation,
      phase: "archives",
      sessionId: parsed.sessionId,
    };
  }
  throw new Error(`${pathname} has an invalid historical transcript migration cursor`);
}

function readMigrationCursor(database: DatabaseSync, pathname: string): MigrationCursor {
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("schema_meta").select("app_version").where("meta_key", "=", MIGRATION_META_KEY),
  );
  return parseMigrationCursor(row?.app_version, pathname);
}

function writeMigrationCursor(
  database: DatabaseSync,
  agentId: string,
  cursor: MigrationCursor,
): void {
  const now = Date.now();
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  executeSqliteQuerySync(
    database,
    db
      .insertInto("schema_meta")
      .values({
        agent_id: agentId,
        app_version: JSON.stringify(cursor),
        created_at: now,
        meta_key: MIGRATION_META_KEY,
        role: "agent",
        schema_version: 1,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("meta_key").doUpdateSet({
          agent_id: agentId,
          app_version: JSON.stringify(cursor),
          role: "agent",
          schema_version: 1,
          updated_at: now,
        }),
      ),
  );
}

function parseTranscriptEvent(raw: string, owner: string): TranscriptEvent {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${owner} contains invalid transcript JSON`, { cause: error });
  }
}

function listTranscriptSessionBatch(database: DatabaseSync, afterSessionId: string): string[] {
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select("session_id")
      .distinct()
      .where("session_id", ">", afterSessionId)
      .where("event_json", "like", "%[[%")
      .orderBy("session_id", "asc")
      .limit(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE),
  ).rows.map((row) => row.session_id);
}

function planTranscriptSession(
  database: DatabaseSync,
  pathname: string,
  sessionId: string,
): TranscriptRowPlan[] {
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", sessionId)
      .where("event_json", "like", "%[[%")
      .orderBy("seq", "asc"),
  ).rows.map((row) => {
    const event = parseTranscriptEvent(row.event_json, `${pathname}:${sessionId}:${row.seq}`);
    const transformed = transformHistoricalTranscriptEvent(event);
    return {
      eventJson: row.event_json,
      rewrittenEventJson: transformed.changed ? JSON.stringify(transformed.event) : row.event_json,
      seq: row.seq,
    };
  });
}

function assertTranscriptSessionSourceUnchanged(
  database: DatabaseSync,
  sessionId: string,
  planned: readonly TranscriptRowPlan[],
): void {
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  const current = executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", sessionId)
      .where("event_json", "like", "%[[%")
      .orderBy("seq", "asc"),
  ).rows;
  if (
    current.length !== planned.length ||
    current.some(
      (row, index) =>
        row.seq !== planned[index]?.seq || row.event_json !== planned[index]?.eventJson,
    )
  ) {
    throw new Error(`Transcript source changed before migration commit for ${sessionId}`);
  }
}

function migrateTranscriptSessions(params: {
  agentId: string;
  database: DatabaseSync;
  owner: OpenClawAgentDatabase;
  pathname: string;
  start: Extract<MigrationCursor, { phase: "transcripts" }>;
}): number {
  let rewrittenSessions = 0;
  let afterSessionId = params.start.sessionId;
  while (true) {
    const sessionIds = listTranscriptSessionBatch(params.database, afterSessionId);
    if (sessionIds.length === 0) {
      runSqliteImmediateTransactionSync(params.database, () => {
        writeMigrationCursor(params.database, params.agentId, {
          generation: "",
          phase: "archives",
          sessionId: "",
        });
      });
      return rewrittenSessions;
    }
    for (const sessionId of sessionIds) {
      const planned = planTranscriptSession(params.database, params.pathname, sessionId);
      const changedRows = planned.filter((row) => row.rewrittenEventJson !== row.eventJson);
      runSqliteImmediateTransactionSync(
        params.database,
        () => {
          assertTranscriptSessionSourceUnchanged(params.database, sessionId, planned);
          updateSqliteTranscriptEventJsonInTransaction(
            params.owner,
            sessionId,
            changedRows.map((row) => ({
              eventJson: row.rewrittenEventJson,
              seq: row.seq,
            })),
          );
          writeMigrationCursor(params.database, params.agentId, {
            phase: "transcripts",
            sessionId,
          });
        },
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: params.pathname,
          operationLabel: "historical-transcript-directives",
        },
      );
      rewrittenSessions += changedRows.length > 0 ? 1 : 0;
      afterSessionId = sessionId;
    }
  }
}

function migrateAgentDatabase(params: {
  agentId: string;
  pathname: string;
}): DatabaseMigrationResult {
  migrateOpenClawAgentDatabaseForMaintenance(params);
  const database = openNodeSqliteDatabase(params.pathname);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertOpenClawAgentDatabaseForMaintenance(database, params);
    const cursor = readMigrationCursor(database, params.pathname);
    if (cursor.phase === "complete") {
      return { archivedTranscripts: 0, transcriptSessions: 0 };
    }
    const owner = createMigrationDatabaseHandle(database, params.agentId, params.pathname);
    const transcriptSessions =
      cursor.phase === "transcripts"
        ? migrateTranscriptSessions({
            agentId: params.agentId,
            database,
            owner,
            pathname: params.pathname,
            start: cursor,
          })
        : 0;
    const archiveCursor = readMigrationCursor(database, params.pathname);
    const archivedTranscripts =
      archiveCursor.phase === "archives"
        ? migrateTranscriptDirectiveArchives({
            agentId: params.agentId,
            database,
            pathname: params.pathname,
            start: archiveCursor,
            writeCursor: (next) =>
              writeMigrationCursor(
                database,
                params.agentId,
                "phase" in next ? next : { ...next, phase: "archives" },
              ),
          })
        : 0;
    return { archivedTranscripts, transcriptSessions };
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

/** One-time startup migration from inline assistant directives to typed delivery facts. */
export function migrateHistoricalTranscriptDirectives(
  params: {
    configuredAgentDatabaseTargets?: readonly { agentId: string; path: string }[];
    env?: NodeJS.ProcessEnv;
  } = {},
): MigrationMessages {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  const targets = resolveAgentDatabaseMigrationTargets({
    changes,
    configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
    env,
    warnings,
  });
  for (const target of targets) {
    try {
      const result = migrateAgentDatabase({ agentId: target.agentId, pathname: target.path });
      if (result.transcriptSessions > 0 || result.archivedTranscripts > 0) {
        changes.push(
          `Migrated historical transcript directives in ${target.path}: ${result.transcriptSessions} active session(s), ${result.archivedTranscripts} archived transcript(s).`,
        );
      }
    } catch (error) {
      warnings.push(
        `Skipped historical transcript directive migration for ${target.path}: ${String(error)}`,
      );
    }
  }
  return { changes, warnings };
}
