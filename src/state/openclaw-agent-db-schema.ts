import type { DatabaseSync } from "node:sqlite";
import { migrateMemoryIndexSourcesIdentity } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  repairCanonicalSqliteUniqueIndexes,
  type CanonicalSqliteUniqueIndex,
} from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity, assertSqliteTableIntegrity } from "../infra/sqlite-integrity.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { VERSION } from "../version.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  backfillSessionConversations,
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
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";
import { AGENT_SCHEMA_WITHOUT_LAZY_SURFACES_SQL } from "./openclaw-agent-session-sharing-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";

const OPENCLAW_AGENT_CANONICAL_UNIQUE_INDEXES = [
  {
    name: "idx_agent_conversations_identity",
    definition: `
      ON conversations(
        channel,
        account_id,
        kind,
        peer_id,
        IFNULL(parent_conversation_id, ''),
        IFNULL(thread_id, '')
      )
    `,
  },
  {
    name: "idx_agent_session_conversations_primary",
    definition: `
      ON session_conversations(session_id)
      WHERE role = 'primary'
    `,
  },
  {
    name: "idx_agent_transcript_message_idempotency",
    definition: `
      ON transcript_event_identities(session_id, message_idempotency_key)
      WHERE message_idempotency_key IS NOT NULL
    `,
  },
  {
    name: "idx_agent_transcript_active_event_seq",
    definition: "ON session_transcript_active_events(session_id, event_seq)",
  },
  {
    name: "idx_agent_transcript_active_messages",
    definition: `
      ON session_transcript_active_events(session_id, message_position)
      WHERE message_position IS NOT NULL
    `,
  },
] as const satisfies readonly CanonicalSqliteUniqueIndex[];

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

function migrateOpenClawAgentSchema(db: DatabaseSync): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion >= OPENCLAW_AGENT_SCHEMA_VERSION) {
    return;
  }
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

function migratedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function migratedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function migratedChatType(value: unknown): "direct" | "group" | "channel" | null {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return null;
}

function migratedStatus(
  value: unknown,
): "running" | "done" | "failed" | "killed" | "timeout" | null {
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
  pathname: string,
): void {
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (
    (userVersion === 0 && hasApplicationSchema) ||
    (userVersion > 0 && userVersion < OPENCLAW_AGENT_SCHEMA_VERSION)
  ) {
    // Migration rewrites the schema; prove the whole file before that mutation.
    // Only a truly empty v0 file may skip; legacy v0 files need the same proof.
    agentDbLog.info("agent database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    assertSqliteIntegrity(database, pathname);
    return;
  }
  const schemaMetaExists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  if (schemaMetaExists) {
    assertSqliteTableIntegrity(database, pathname, "schema_meta");
  }
}

function ensureAgentSchema(db: DatabaseSync, agentId: string, pathname: string): void {
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
      if (previousVersion < 11) {
        backfillSessionConversations(db);
      }
      backfillSessionEntryProvenance(db, previousVersion);
      migrateSessionNodesAndWindows(db, previousVersion);
      db.exec(
        previousVersion === OPENCLAW_AGENT_SCHEMA_VERSION
          ? AGENT_SCHEMA_WITHOUT_LAZY_SURFACES_SQL
          : OPENCLAW_AGENT_SCHEMA_SQL,
      );
      migrateSessionTranscriptGenerations(db, previousVersion);
      migrateSessionTranscriptActiveProjection(db, previousVersion);
      if (previousVersion < 11) {
        migrateSqliteSchemaToStrictInTransaction(db, OPENCLAW_AGENT_SCHEMA_SQL, {
          databaseLabel: pathname,
        });
      }
      repairCanonicalSqliteUniqueIndexes(db, pathname, OPENCLAW_AGENT_CANONICAL_UNIQUE_INDEXES);
      const kysely = getNodeSqliteKysely<OpenClawAgentMetadataDatabase>(db);
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
      const now = Date.now();
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("schema_meta")
          .values({
            meta_key: "primary",
            role: "agent",
            schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
            agent_id: agentId,
            app_version: VERSION,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("meta_key").doUpdateSet({
              role: "agent",
              schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
              agent_id: agentId,
              app_version: VERSION,
              updated_at: now,
            }),
          ),
      );
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
  assertAgentDatabaseIntegrityBeforeMutation(db, pathname);
  configureSqlitePreSchemaPragmas(db, {
    busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  });
  ensureAgentSchema(db, agentId, pathname);
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  if (options.register === true) {
    registerOpenClawAgentDatabase({ agentId, path: pathname, env: options.env });
  }
}

export { ensureAgentSchema as ensureOpenClawAgentSchema };
