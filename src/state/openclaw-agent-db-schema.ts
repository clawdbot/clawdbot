import type { DatabaseSync } from "node:sqlite";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeNullableString as migratedText } from "@openclaw/normalization-core/string-coerce";
import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  ensureMemoryChunkProvenance,
  ensureMemoryRecallMetadataSchema,
  hasLegacyMemoryRecallMetadataColumns,
  migrateMemoryIndexSourcesIdentity,
} from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
} from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { VERSION } from "../version.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "./openclaw-agent-board-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import {
  assertExistingAgentSchemaOwner,
  assertOpenClawAgentSchemaContains,
  assertOpenClawAgentCurrentRuntimeSchema,
  assertSupportedAgentSchemaVersion,
  ensureSessionKeyContractSchemaInTransaction,
  readExistingAgentSchemaMeta,
  repairAndAssertOpenClawAgentV14SchemaForMigration,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  backfillSessionConversations,
  ensureSessionEntryValidityProjection,
  migrateConversationDeliveryTargetColumn,
  migrateSessionEntryStatusProjection,
  readSqliteTableColumns,
} from "./openclaw-agent-db-session-migrations.js";
import { migrateSessionNodesAndWindows } from "./openclaw-agent-db-session-nodes-migration.js";
import {
  addSessionProvenanceColumns,
  backfillSessionEntryProvenance,
  backfillTranscriptMutationWatermarks,
} from "./openclaw-agent-db-session-provenance.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";

type OpenClawAgentMetadataDatabase = Pick<OpenClawAgentKyselyDatabase, "schema_meta">;
type MigratedSessionEntry = Record<string, unknown>;

const agentDbLog = createSubsystemLogger("state/agent-db");

function migratedSessionColumn(
  columns: ReadonlySet<string>,
  columnName: string,
  fallback: string,
): string {
  return columns.has(columnName) ? columnName : fallback;
}

function dropLegacySessionTranscriptSearchSchema(db: DatabaseSync): void {
  // The pre-landing sessions_search branch tracked JSONL file watermarks and
  // stored session_key inside the FTS table. Both are derived caches; drop
  // them so reconcile rebuilds the row-native index shape.
  db.exec("DROP TABLE IF EXISTS session_transcript_files;");
  const columns = db.prepare("PRAGMA table_info(session_transcript_fts)").all() as Array<{
    name?: unknown;
  }>;
  if (columns.some((row) => row.name === "session_key")) {
    db.exec(`
      DROP TABLE IF EXISTS session_transcript_fts;
      DROP TABLE IF EXISTS session_transcript_index_state;
    `);
  }
}

function dropLegacyMemoryIndexSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(memory_index_sources)").all() as Array<{
    name?: unknown;
  }>;
  const hasLegacySourceColumns = columns.some((row) => row.name === "source_kind");
  if (!hasLegacySourceColumns) {
    return;
  }
  // Memory indexes are derived cache data; v1 used a different key shape.
  db.exec(`
    DROP TABLE IF EXISTS memory_index_chunks_fts;
    DROP TABLE IF EXISTS memory_index_chunks;
    DROP TABLE IF EXISTS memory_index_sources;
  `);
}

function hasLegacyMemoryChunkProvenanceTrigger(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_index_chunk_provenance_after_insert'",
      )
      .get(),
  );
}

function hasPendingMemoryChunkMetadataMigration(db: DatabaseSync): boolean {
  return hasLegacyMemoryRecallMetadataColumns(db) || hasLegacyMemoryChunkProvenanceTrigger(db);
}

function hasPendingSessionKeyContractSchemaMigration(db: DatabaseSync): boolean {
  const sessionNodeColumns = readSqliteTableColumns(db, "session_nodes");
  if (!sessionNodeColumns) {
    return false;
  }
  const hasContractTable = Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_key_contract'")
      .get(),
  );
  return !sessionNodeColumns.has("entry_valid") || !hasContractTable;
}

function migrateMemoryChunkMetadataSchema(db: DatabaseSync): void {
  ensureMemoryRecallMetadataSchema(db);
  ensureMemoryChunkProvenance(db);
}

function migrateOpenClawAgentSchema(db: DatabaseSync): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion >= OPENCLAW_AGENT_SCHEMA_VERSION) {
    return;
  }
  // Remove after 2026-10-01: drop the v1-v6 ladder once the minimum supported agent schema is 7.
  if (userVersion < 7) {
    db.exec("DROP INDEX IF EXISTS idx_agent_sessions_status;");
    migrateSessionEntryStatusProjection(db, (entryJson) => {
      const entry = parseMigratedSessionEntry(entryJson);
      return entry ? migratedStatus(entry.status) : null;
    });
  }
  if (userVersion < 6) {
    db.exec("DROP INDEX IF EXISTS idx_agent_session_entries_session_id;");
  }
  if (userVersion < 3) {
    db.exec("DROP INDEX IF EXISTS idx_agent_transcript_events_session;");
  }
  const columns = readSqliteTableColumns(db, "sessions");
  if (columns && !columns.has("transcript_updated_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN transcript_updated_at INTEGER DEFAULT NULL;");
  }
  if (columns && !columns.has("transcript_observed_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN transcript_observed_at INTEGER DEFAULT NULL;");
  }
  addSessionProvenanceColumns(db, columns);
  if (!columns) {
    return;
  }
  if (userVersion > 1) {
    backfillTranscriptMutationWatermarks(db);
    return;
  }
  const copyColumns = [
    "session_id",
    "session_key",
    "session_scope",
    "created_at",
    "updated_at",
    "session_entry_provenance",
    "acp_owned",
    "plugin_owner_id",
    "hook_external_content_source",
    "started_at",
    "ended_at",
    "status",
    "chat_type",
    "channel",
    "account_id",
    "primary_conversation_id",
    "model_provider",
    "model",
    "agent_harness_id",
    "parent_session_key",
    "spawned_by",
    "display_name",
  ];
  const selectColumns = [
    "session_id",
    "session_key",
    migratedSessionColumn(columns, "session_scope", "'conversation'"),
    "created_at",
    "updated_at",
    migratedSessionColumn(columns, "session_entry_provenance", "0"),
    migratedSessionColumn(columns, "acp_owned", "0"),
    migratedSessionColumn(columns, "plugin_owner_id", "NULL"),
    migratedSessionColumn(columns, "hook_external_content_source", "NULL"),
    migratedSessionColumn(columns, "started_at", "NULL"),
    migratedSessionColumn(columns, "ended_at", "NULL"),
    migratedSessionColumn(columns, "status", "NULL"),
    migratedSessionColumn(columns, "chat_type", "NULL"),
    migratedSessionColumn(columns, "channel", "NULL"),
    migratedSessionColumn(columns, "account_id", "NULL"),
    migratedSessionColumn(columns, "primary_conversation_id", "NULL"),
    migratedSessionColumn(columns, "model_provider", "NULL"),
    migratedSessionColumn(columns, "model", "NULL"),
    migratedSessionColumn(columns, "agent_harness_id", "NULL"),
    migratedSessionColumn(columns, "parent_session_key", "NULL"),
    migratedSessionColumn(columns, "spawned_by", "NULL"),
    migratedSessionColumn(columns, "display_name", "NULL"),
  ];
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT NOT NULL PRIMARY KEY,
      channel TEXT NOT NULL,
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'channel')),
      peer_id TEXT NOT NULL,
      delivery_target TEXT NOT NULL,
      parent_conversation_id TEXT,
      thread_id TEXT,
      native_channel_id TEXT,
      native_direct_user_id TEXT,
      label TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
      DROP TABLE IF EXISTS sessions_new;
      CREATE TABLE sessions_new (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_scope TEXT NOT NULL DEFAULT 'conversation' CHECK (session_scope IN ('conversation', 'shared-main', 'group', 'channel')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        transcript_updated_at INTEGER DEFAULT NULL,
        transcript_observed_at INTEGER DEFAULT NULL,
        session_entry_provenance INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1)),
        acp_owned INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1)),
        plugin_owner_id TEXT,
        hook_external_content_source TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook')),
        started_at INTEGER,
        ended_at INTEGER,
        status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
        chat_type TEXT CHECK (chat_type IS NULL OR chat_type IN ('direct', 'group', 'channel')),
        channel TEXT,
        account_id TEXT,
        primary_conversation_id TEXT,
        model_provider TEXT,
        model TEXT,
        agent_harness_id TEXT,
        parent_session_key TEXT,
        spawned_by TEXT,
        display_name TEXT,
        FOREIGN KEY (primary_conversation_id) REFERENCES conversations(conversation_id) ON DELETE SET NULL
      );
      INSERT INTO sessions_new (${copyColumns.join(", ")})
      SELECT ${selectColumns.join(", ")} FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
  backfillTranscriptMutationWatermarks(db);
}

/** Backfill one generation token without copying or rewriting transcript rows. */
function migrateSessionTranscriptGenerations(db: DatabaseSync, previousVersion: number): void {
  // Remove after 2026-10-01: drop the generation backfill once the minimum supported agent schema is 13.
  if (previousVersion >= 13) {
    return;
  }
  db.prepare(
    `INSERT OR IGNORE INTO transcript_rewrite_watermarks (session_id, generation, updated_at)
     SELECT session_id, lower(hex(randomblob(16))), ?
     FROM transcript_events
     GROUP BY session_id`,
  ).run(Date.now());
}

function migrateSessionTranscriptActiveProjection(db: DatabaseSync, previousVersion: number): void {
  if (previousVersion >= 10) {
    return;
  }
  const columns = readSqliteTableColumns(db, "session_transcript_index_state");
  if (columns && !columns.has("active_event_count")) {
    db.exec(
      "ALTER TABLE session_transcript_index_state ADD COLUMN active_event_count INTEGER NOT NULL DEFAULT 0;",
    );
  }
  if (columns && !columns.has("active_message_count")) {
    db.exec(
      "ALTER TABLE session_transcript_index_state ADD COLUMN active_message_count INTEGER NOT NULL DEFAULT 0;",
    );
  }
  // This table is derived state. Gateway startup rebuilds it after all legacy
  // imports finish, keeping schema-open work cheap and history reads bounded.
  db.exec(`
    DELETE FROM session_transcript_active_events;
    UPDATE session_transcript_index_state
    SET needs_rebuild = 1,
        active_event_count = 0,
        active_message_count = 0,
        updated_at = ${Date.now()};
  `);
}

function parseMigratedSessionEntry(value: unknown): MigratedSessionEntry | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as MigratedSessionEntry)
      : null;
  } catch {
    return null;
  }
}

function migratedObjectField(
  entry: MigratedSessionEntry,
  key: string,
): MigratedSessionEntry | null {
  const value = entry[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MigratedSessionEntry)
    : null;
}

function migratedNumber(value: unknown): number | null {
  return asFiniteNumber(value) ?? null;
}

function migratedChatType(value: unknown): "direct" | "group" | "channel" | null {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return null;
}

function migratedStatus(value: unknown): SessionRunStatus | null {
  if (
    value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
  ) {
    return value;
  }
  return null;
}

function migratedSessionScope(
  entry: MigratedSessionEntry,
  sessionKey: string,
): "conversation" | "shared-main" | "group" | "channel" {
  const chatType = migratedChatType(entry.chatType);
  const normalizedKey = sessionKey.trim().toLowerCase();
  if (chatType === "direct" && (normalizedKey === "main" || normalizedKey.endsWith(":main"))) {
    return "shared-main";
  }
  if (chatType === "group" || chatType === "channel") {
    return chatType;
  }
  return "conversation";
}

function migratedEntryChannel(entry: MigratedSessionEntry): string | null {
  const delivery = migratedObjectField(entry, "delivery");
  const deliveryContext =
    migratedObjectField(delivery ?? {}, "context") ?? migratedObjectField(entry, "deliveryContext");
  const origin =
    migratedObjectField(delivery ?? {}, "origin") ?? migratedObjectField(entry, "origin");
  return (
    migratedText(entry.channel) ??
    migratedText(deliveryContext?.channel) ??
    migratedText(entry.lastChannel) ??
    migratedText(origin?.provider)
  );
}

function migratedEntryAccountId(entry: MigratedSessionEntry): string | null {
  const delivery = migratedObjectField(entry, "delivery");
  const deliveryContext =
    migratedObjectField(delivery ?? {}, "context") ?? migratedObjectField(entry, "deliveryContext");
  const origin =
    migratedObjectField(delivery ?? {}, "origin") ?? migratedObjectField(entry, "origin");
  return (
    migratedText(deliveryContext?.accountId) ??
    migratedText(entry.lastAccountId) ??
    migratedText(origin?.accountId)
  );
}

function migratedEntryDisplayName(entry: MigratedSessionEntry): string | null {
  return (
    migratedText(entry.displayName) ??
    migratedText(entry.label) ??
    migratedText(entry.subject) ??
    migratedText(entry.groupId)
  );
}

function backfillOpenClawAgentSchema(db: DatabaseSync, previousVersion: number): void {
  if (previousVersion >= 2) {
    return;
  }
  if (!readSqliteTableColumns(db, "session_entries") || !readSqliteTableColumns(db, "sessions")) {
    return;
  }
  if (!readSqliteTableColumns(db, "session_routes")) {
    db.exec(`
      CREATE TABLE session_routes (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
    `);
  }
  db.exec(`
    INSERT OR REPLACE INTO session_routes (session_key, session_id, updated_at)
    SELECT se.session_key, se.session_id, se.updated_at
    FROM session_entries AS se
    INNER JOIN sessions AS s ON s.session_id = se.session_id;
  `);
  const rows = db
    .prepare(
      `
        SELECT se.session_key, se.session_id, se.entry_json
        FROM session_entries AS se
        INNER JOIN sessions AS s ON s.session_id = se.session_id;
      `,
    )
    .all() as Array<{
    entry_json?: unknown;
    session_id?: unknown;
    session_key?: unknown;
  }>;
  const update = db.prepare(`
    UPDATE sessions
    SET
      session_scope = ?,
      started_at = ?,
      ended_at = ?,
      status = ?,
      chat_type = ?,
      channel = ?,
      account_id = ?,
      model_provider = ?,
      model = ?,
      agent_harness_id = ?,
      parent_session_key = ?,
      spawned_by = ?,
      display_name = ?
    WHERE session_id = ?;
  `);
  for (const row of rows) {
    const sessionKey = migratedText(row.session_key);
    const sessionId = migratedText(row.session_id);
    const entry = parseMigratedSessionEntry(row.entry_json);
    if (!sessionKey || !sessionId || !entry) {
      continue;
    }
    update.run(
      migratedSessionScope(entry, sessionKey),
      migratedNumber(entry.startedAt),
      migratedNumber(entry.endedAt),
      migratedStatus(entry.status),
      migratedChatType(entry.chatType),
      migratedEntryChannel(entry),
      migratedEntryAccountId(entry),
      migratedText(entry.modelProvider),
      migratedText(entry.model),
      migratedText(entry.agentHarnessId),
      migratedText(entry.parentSessionKey),
      migratedText(entry.spawnedBy),
      migratedEntryDisplayName(entry),
      sessionId,
    );
  }
}

export function assertAgentDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
): void {
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  const migrationPending =
    (userVersion === 0 && hasApplicationSchema) ||
    (userVersion > 0 && userVersion < OPENCLAW_AGENT_SCHEMA_VERSION);
  if (migrationPending) {
    agentDbLog.info("agent database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  }
  const hasPendingMemoryMigration =
    userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
    hasPendingMemoryChunkMetadataMigration(database);
  const hasPendingSessionContractMigration =
    userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
    hasPendingSessionKeyContractSchemaMigration(database);
  const hasPendingAdditiveMigration =
    hasPendingMemoryMigration || hasPendingSessionContractMigration;
  if (userVersion === OPENCLAW_AGENT_SCHEMA_VERSION && !hasPendingAdditiveMigration) {
    verifyAndRepairCanonicalSqliteIndexes(database, pathname, OPENCLAW_AGENT_SCHEMA_SQL, {
      allowMissingColumns: true,
      validateAfterRepair: () =>
        assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname }),
    });
  } else {
    // Every physical open proves the full file before schema mutation or exposure.
    assertSqliteIntegrity(database, pathname);
  }
  // Current-version additive surfaces are installed atomically by ensureAgentSchema below.
  // Validating them here would make the same-version repair path unreachable after an update.
  if (userVersion === OPENCLAW_AGENT_SCHEMA_VERSION && !hasPendingAdditiveMigration) {
    assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname });
  }
}

function assertAgentSchemaVersion(
  db: DatabaseSync,
  options: { agentId: string; pathname: string; version: number },
): void {
  const metadata = readExistingAgentSchemaMeta(db);
  assertExistingAgentSchemaOwner(metadata, options.agentId, options.pathname);
  const userVersion = readSqliteUserVersion(db);
  if (userVersion !== options.version || metadata?.schemaVersion !== options.version) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} did not converge on schema version ${options.version}.`,
    );
  }
  assertOpenClawAgentSchemaContains(db, options.pathname, OPENCLAW_AGENT_SCHEMA_SQL);
}

function ensureAgentSchema(
  db: DatabaseSync,
  agentId: string,
  pathname: string,
  targetVersion = OPENCLAW_AGENT_SCHEMA_VERSION,
): void {
  // FK enforcement must be off before BEGIN: PRAGMA foreign_keys is a silent
  // no-op inside a transaction, and legacy owner-table rebuilds would otherwise
  // cascade-delete their children. Steady-state enforcement is restored below.
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = OFF;");
  try {
    runSqliteImmediateTransactionSync(db, () => {
      // Repeat preflight ownership/version gates inside the write transaction;
      // concurrent openers must not overwrite another agent after the scan.
      // Role/ownership gates before version: user_version is only meaningful
      // within one schema role, and the global state DB now carries version 3.
      assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
      assertSupportedAgentSchemaVersion(db, pathname);
      const previousVersion = readSqliteUserVersion(db);
      if (previousVersion > targetVersion) {
        throw new Error(
          `OpenClaw agent database ${pathname} uses schema version ${previousVersion}; expected at most ${targetVersion} for this migration.`,
        );
      }
      if (previousVersion === targetVersion) {
        ensureSessionEntryValidityProjection(db);
        ensureSessionKeyContractSchemaInTransaction(db);
        if (hasPendingMemoryChunkMetadataMigration(db)) {
          migrateMemoryChunkMetadataSchema(db);
          db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
        }
        // Repeat index repair before the transactional schema assertion so a
        // concurrent opener cannot turn repairable drift into a hard refusal.
        repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_AGENT_SCHEMA_SQL, {
          verifyPhysicalIntegrity: false,
        });
        assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion });
        return;
      } else if (previousVersion === 14) {
        repairAndAssertOpenClawAgentV14SchemaForMigration(db, { agentId, pathname });
      }
      // Two legacy memory shapes exist: the flip lineage's source_kind schema
      // (derived cache — dropped for rebuild) and main's path/source-keyed
      // schema (migrated in place by the identity migration). Both helpers are
      // structure-gated, so this ordering converges every lineage — pre-flip
      // v1/v2 and pre-merge flip v1/v4 — without version-number coupling.
      dropLegacyMemoryIndexSchema(db);
      dropLegacySessionTranscriptSearchSchema(db);
      migrateMemoryIndexSourcesIdentity(db);
      migrateOpenClawAgentSchema(db);
      migrateConversationDeliveryTargetColumn(db);
      backfillOpenClawAgentSchema(db, previousVersion);
      // Remove after 2026-10-01: drop the pre-v11 conversation backfill once schema 11 is the support floor.
      if (previousVersion < 11) {
        backfillSessionConversations(db);
      }
      backfillSessionEntryProvenance(db, previousVersion);
      migrateSessionNodesAndWindows(db, previousVersion);
      ensureSessionEntryValidityProjection(db);
      db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      migrateMemoryChunkMetadataSchema(db);
      if (previousVersion < targetVersion) {
        ensureOpenClawAgentBoardSchemaInTransaction(db);
      }
      migrateSessionTranscriptGenerations(db, previousVersion);
      migrateSessionTranscriptActiveProjection(db, previousVersion);
      if (previousVersion < 11) {
        migrateSqliteSchemaToStrictInTransaction(db, OPENCLAW_AGENT_SCHEMA_SQL, {
          databaseLabel: pathname,
        });
      }
      repairCanonicalSqliteIndexes(db, pathname, OPENCLAW_AGENT_SCHEMA_SQL, {
        verifyPhysicalIntegrity: false,
      });
      const kysely = getNodeSqliteKysely<OpenClawAgentMetadataDatabase>(db);
      db.exec(`PRAGMA user_version = ${targetVersion};`);
      const now = Date.now();
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("schema_meta")
          .values({
            meta_key: "primary",
            role: "agent",
            schema_version: targetVersion,
            agent_id: agentId,
            app_version: VERSION,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("meta_key").doUpdateSet({
              role: "agent",
              schema_version: targetVersion,
              agent_id: agentId,
              app_version: VERSION,
              updated_at: now,
            }),
          ),
      );
      assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion });
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/** Initialize agent schema/ownership metadata on an independently managed connection. */
export function ensureOpenClawAgentDatabaseSchema(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions & { register?: boolean },
): void {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  assertSupportedAgentSchemaVersion(db, pathname);
  assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
  assertAgentDatabaseIntegrityBeforeMutation(db, agentId, pathname);
  configureSqlitePreSchemaPragmas(db, {
    busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  });
  ensureAgentSchema(db, agentId, pathname);
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  if (options.register === true) {
    registerOpenClawAgentDatabase({ agentId, path: pathname, env: options.env });
  }
}

/** Upgrade older owned databases to the structural schema required by the media cutover. */
export function migrateOpenClawAgentDatabaseToMediaPrerequisiteSchema(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions,
): void {
  const targetVersion = OPENCLAW_AGENT_SCHEMA_VERSION - 1;
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > targetVersion) {
    return;
  }
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  assertAgentDatabaseIntegrityBeforeMutation(db, agentId, pathname);
  configureSqlitePreSchemaPragmas(db, {
    busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  });
  ensureAgentSchema(db, agentId, pathname, targetVersion);
}

export { ensureAgentSchema as ensureOpenClawAgentSchema };
