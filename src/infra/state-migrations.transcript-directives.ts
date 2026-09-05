import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  OpenClawAgentDatabaseLeaseActiveError,
  assertAgentDatabaseMaintenanceAuthority,
  assertNoOpenClawAgentDatabaseLeases,
} from "../state/openclaw-agent-db-lease.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "../state/openclaw-agent-db-maintenance.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  type OpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "../state/openclaw-agent-db.js";
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
  transcriptDirectiveArchivesNeedMigration,
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

function transcriptSessionsNeedMigration(
  database: DatabaseSync,
  pathname: string,
  afterSessionId: string,
): boolean {
  let cursor = afterSessionId;
  while (true) {
    const sessionIds = listTranscriptSessionBatch(database, cursor);
    if (sessionIds.length === 0) {
      return false;
    }
    for (const sessionId of sessionIds) {
      if (
        planTranscriptSession(database, pathname, sessionId).some(
          (row) => row.rewrittenEventJson !== row.eventJson,
        )
      ) {
        return true;
      }
    }
    cursor = sessionIds.at(-1) ?? cursor;
  }
}

function hasActiveAgentDatabaseLease(agentId: string, env: NodeJS.ProcessEnv): boolean {
  try {
    assertNoOpenClawAgentDatabaseLeases(agentId, { env });
    return false;
  } catch (error) {
    if (error instanceof OpenClawAgentDatabaseLeaseActiveError) {
      return true;
    }
    throw error;
  }
}

async function yieldBetweenTranscriptBatches(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function migrateTranscriptSessions(params: {
  agentId: string;
  database: DatabaseSync;
  owner: OpenClawAgentDatabase;
  pathname: string;
  start: Extract<MigrationCursor, { phase: "transcripts" }>;
}): Promise<number> {
  let rewrittenSessions = 0;
  let afterSessionId = params.start.sessionId;
  while (true) {
    const sessionIds = listTranscriptSessionBatch(params.database, afterSessionId);
    if (sessionIds.length === 0) {
      runSqliteImmediateTransactionSync(params.database, () => {
        assertAgentDatabaseMaintenanceAuthority();
        writeMigrationCursor(params.database, params.agentId, {
          generation: "",
          phase: "archives",
          sessionId: "",
        });
        assertAgentDatabaseMaintenanceAuthority();
      });
      return rewrittenSessions;
    }
    for (const sessionId of sessionIds) {
      const planned = planTranscriptSession(params.database, params.pathname, sessionId);
      const changedRows = planned.filter((row) => row.rewrittenEventJson !== row.eventJson);
      runSqliteImmediateTransactionSync(
        params.database,
        () => {
          assertAgentDatabaseMaintenanceAuthority();
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
          assertAgentDatabaseMaintenanceAuthority();
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
    // Keep the caller responsive between bounded batches. The next transaction
    // revalidates maintenance ownership before mutating state.
    await yieldBetweenTranscriptBatches();
  }
}

async function migrateAgentDatabase(params: {
  agentId: string;
  pathname: string;
}): Promise<DatabaseMigrationResult> {
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
        ? await migrateTranscriptSessions({
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
        ? await migrateTranscriptDirectiveArchives({
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

function agentDatabaseNeedsTranscriptDirectiveMigration(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  pathname: string;
}): boolean {
  const database = openNodeSqliteDatabase(params.pathname, { readOnly: true });
  try {
    const userVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      return true;
    }
    try {
      assertOpenClawAgentDatabaseForMaintenance(database, params);
    } catch {
      return true;
    }
    const cursor = readMigrationCursor(database, params.pathname);
    if (cursor.phase === "complete") {
      return false;
    }
    if (
      cursor.phase === "transcripts" &&
      transcriptSessionsNeedMigration(database, params.pathname, cursor.sessionId)
    ) {
      return true;
    }
    if (
      transcriptDirectiveArchivesNeedMigration(
        database,
        cursor.phase === "archives"
          ? { generation: cursor.generation, sessionId: cursor.sessionId }
          : { generation: "", sessionId: "" },
      )
    ) {
      return true;
    }
    return !hasActiveAgentDatabaseLease(params.agentId, params.env);
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

/** One-time startup migration from inline assistant directives to typed delivery facts. */
export async function migrateHistoricalTranscriptDirectives(
  params: {
    configuredAgentDatabaseTargets?: readonly { agentId: string; path: string }[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MigrationMessages> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  try {
    const discoveredTargets = resolveAgentDatabaseMigrationTargets({
      changes,
      configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
      env,
      warnings,
    });
    const targets: typeof discoveredTargets = [];
    for (const target of discoveredTargets) {
      try {
        if (
          agentDatabaseNeedsTranscriptDirectiveMigration({
            agentId: target.agentId,
            env,
            pathname: target.path,
          })
        ) {
          targets.push(target);
        }
      } catch (error) {
        warnings.push(
          `Skipped historical transcript directive migration preflight for ${target.path}: ${String(error)}`,
        );
      }
    }
    if (targets.length === 0) {
      return { changes, warnings };
    }
    await withAgentDatabaseMaintenanceLease({ env }, async () => {
      for (const target of targets) {
        try {
          const result = await migrateAgentDatabase({
            agentId: target.agentId,
            pathname: target.path,
          });
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
    });
  } catch (error) {
    warnings.push(`Skipped historical transcript directive migration: ${String(error)}`);
  }
  return { changes, warnings };
}
