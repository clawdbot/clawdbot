// OpenClaw agent database stores agent-scoped persisted runtime state.
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrateMemoryIndexSourcesIdentity } from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  repairCanonicalSqliteUniqueIndexes,
  type CanonicalSqliteUniqueIndex,
} from "../infra/sqlite-index-schema.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  migrateSessionEntryStatusProjection,
  readSqliteTableColumns,
} from "./openclaw-agent-db-session-migrations.js";
import {
  addSessionProvenanceColumns,
  backfillSessionEntryProvenance,
  backfillTranscriptMutationWatermarks,
} from "./openclaw-agent-db-session-provenance.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  detectOpenClawStateDatabaseSchemaMigrations,
  OPENCLAW_STATE_SCHEMA_VERSION,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
export { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";

/**
 * Per-agent SQLite database lifecycle and shared-state registration.
 *
 * Each opened agent database is schema-owned by one normalized agent id, cached
 * per pathname, protected with private file modes, and registered in the shared
 * OpenClaw state database for discovery and maintenance.
 */
// v8 = per-transcript session provenance. v7 added per-entry lifecycle status projection.
// v6 added session/transcript hot-path indexes.
// v5 added transcript mutation watermarks.
// The v4 session/transcript flip and main's v2 memory-identity
// change is folded in structure-gated (migrateMemoryIndexSourcesIdentity), so
// v2 main DBs and pre-merge v4 flip DBs both converge on this schema.
export const OPENCLAW_AGENT_SCHEMA_VERSION = 8;
const OPENCLAW_AGENT_DB_DIR_MODE = 0o700;
const OPENCLAW_AGENT_DB_FILE_MODE = 0o600;
const OPENCLAW_AGENT_DB_SLOW_OPEN_MS = 1_000;
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
] as const satisfies readonly CanonicalSqliteUniqueIndex[];
const agentDbLog = createSubsystemLogger("state/agent-db");

/** Open per-agent SQLite database handle plus lifecycle maintenance. */
export type OpenClawAgentDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

/** Options for resolving and opening one agent database. */
export type OpenClawAgentDatabaseOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
};

/** Shared-state registry row describing an agent database seen by this process. */
export type OpenClawRegisteredAgentDatabase = {
  agentId: string;
  path: string;
  schemaVersion: number;
  lastSeenAt: number;
  sizeBytes: number | null;
};

type OpenClawAgentMetadataDatabase = Pick<OpenClawAgentKyselyDatabase, "schema_meta">;
type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

const cachedDatabases = new Map<string, OpenClawAgentDatabase>();

type ExistingSchemaMeta = {
  agentId: string | null;
  role: string | null;
  schemaVersion: number | null;
};

type MigratedSessionEntry = Record<string, unknown>;

function logSlowAgentDatabaseOpen(params: {
  agentId: string;
  elapsedMs: number;
  path: string;
}): void {
  if (params.elapsedMs < OPENCLAW_AGENT_DB_SLOW_OPEN_MS) {
    return;
  }
  agentDbLog.warn("slow OpenClaw agent database open", {
    agentId: params.agentId,
    elapsedMs: params.elapsedMs,
    path: params.path,
    thresholdMs: OPENCLAW_AGENT_DB_SLOW_OPEN_MS,
  });
}

function assertSupportedAgentSchemaVersion(db: DatabaseSync, pathname: string): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw agent database",
      pathname,
      userVersion,
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  }
}

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
  const deliveryContext = migratedObjectField(entry, "deliveryContext");
  const origin = migratedObjectField(entry, "origin");
  return (
    migratedText(entry.channel) ??
    migratedText(deliveryContext?.channel) ??
    migratedText(entry.lastChannel) ??
    migratedText(origin?.provider)
  );
}

function migratedEntryAccountId(entry: MigratedSessionEntry): string | null {
  const deliveryContext = migratedObjectField(entry, "deliveryContext");
  const origin = migratedObjectField(entry, "origin");
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

export function ensureOpenClawAgentDatabasePermissions(
  pathname: string,
  options: OpenClawAgentDatabaseOptions,
): void {
  const dir = path.dirname(pathname);
  const defaultPath = resolveOpenClawAgentSqlitePath({
    agentId: options.agentId,
    env: options.env,
  });
  const isDefaultAgentDatabase = path.resolve(pathname) === path.resolve(defaultPath);
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_AGENT_DB_DIR_MODE });
  // Default agent state is private by contract; custom pre-existing dirs keep caller ownership.
  if (isDefaultAgentDatabase || !dirExisted) {
    chmodSync(dir, OPENCLAW_AGENT_DB_DIR_MODE);
  }
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    if (existsSync(candidate)) {
      chmodSync(candidate, OPENCLAW_AGENT_DB_FILE_MODE);
    }
  }
}

function readExistingSchemaMeta(db: DatabaseSync): ExistingSchemaMeta | null {
  const schemaMetaTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  if (!schemaMetaTable) {
    return null;
  }
  const row = db
    .prepare("SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'")
    .get() as { agent_id?: unknown; role?: unknown; schema_version?: unknown } | undefined;
  if (!row) {
    return null;
  }
  return {
    agentId: typeof row.agent_id === "string" ? row.agent_id : null,
    role: typeof row.role === "string" ? row.role : null,
    schemaVersion: typeof row.schema_version === "number" ? row.schema_version : null,
  };
}

function assertExistingSchemaOwner(
  existing: ExistingSchemaMeta | null,
  agentId: string,
  pathname: string,
): void {
  if (!existing) {
    return;
  }
  // Agent DB files are not interchangeable; opening another role/id would corrupt ownership.
  if (existing.role !== "agent") {
    throw new Error(
      `OpenClaw agent database ${pathname} has schema role ${existing.role ?? "unknown"}; expected agent.`,
    );
  }
  if (!existing.agentId) {
    throw new Error(`OpenClaw agent database ${pathname} has no agent owner.`);
  }
  if (normalizeAgentId(existing.agentId) !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} belongs to agent ${existing.agentId}; requested agent ${agentId}.`,
    );
  }
}

/** Require the exact agent owner and schema before offline file maintenance. */
export function assertOpenClawAgentDatabaseForMaintenance(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingSchemaOwner(metadata, agentId, options.pathname);

  const userVersion = readSqliteUserVersion(database);
  if (userVersion > OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw agent database",
      options.pathname,
      userVersion,
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  }
  if (userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} uses schema version ${userVersion}; run openclaw doctor --fix before compacting it.`,
    );
  }
  if (metadata.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${OPENCLAW_AGENT_SCHEMA_VERSION}; run openclaw doctor --fix before compacting it.`,
    );
  }
  assertSqliteSchemaContains(database, options.pathname, OPENCLAW_AGENT_SCHEMA_SQL);
}

function ensureAgentSchema(db: DatabaseSync, agentId: string, pathname: string): void {
  // FK enforcement must be off before BEGIN: PRAGMA foreign_keys is a silent
  // no-op inside a transaction, and the v1 sessions rebuild would otherwise
  // cascade-delete session_entries when the old parent table drops. The
  // connection pragmas restore enforcement for steady-state work below.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runSqliteImmediateTransactionSync(db, () => {
      // Ownership and version checks must share the write transaction with the
      // schema update; concurrent openers must not overwrite another agent.
      // Role/ownership gates before version: user_version is only meaningful
      // within one schema role, and the global state DB now carries version 2.
      assertExistingSchemaOwner(readExistingSchemaMeta(db), agentId, pathname);
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
      db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      repairCanonicalSqliteUniqueIndexes(db, pathname, OPENCLAW_AGENT_CANONICAL_UNIQUE_INDEXES);
      backfillOpenClawAgentSchema(db, previousVersion);
      backfillSessionEntryProvenance(db, previousVersion);
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
            app_version: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("meta_key").doUpdateSet({
              role: "agent",
              schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
              agent_id: agentId,
              app_version: null,
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
  assertAgentDatabaseIntegrityBeforeMutation(db, pathname);
  configureSqlitePreSchemaPragmas(db, {
    busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  });
  ensureAgentSchema(db, agentId, pathname);
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  if (options.register === true) {
    registerAgentDatabase({ agentId, path: pathname, env: options.env });
  }
}

function registerAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(params.path).size;
  } catch {
    sizeBytes = null;
  }
  const lastSeenAt = Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("agent_databases")
          .values({
            agent_id: params.agentId,
            path: params.path,
            schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
            last_seen_at: lastSeenAt,
            size_bytes: sizeBytes,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "path"]).doUpdateSet({
              schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
              last_seen_at: lastSeenAt,
              size_bytes: sizeBytes,
            }),
          ),
      );
    },
    { env: params.env },
  );
}

function unregisterAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("agent_databases")
          .where("agent_id", "=", params.agentId)
          .where("path", "=", params.path),
      );
    },
    { env: params.env },
  );
}

function hasUnavailableMissingSqlitePath(pathname: string): boolean {
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    try {
      lstatSync(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
  }

  let ancestor = path.dirname(pathname);
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isSymbolicLink()) {
        return !stat.isDirectory();
      }
      try {
        return !statSync(ancestor).isDirectory();
      } catch {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return false;
    }
    ancestor = parent;
  }
}

/** List agent databases recorded in the shared OpenClaw state registry. */
export function listOpenClawRegisteredAgentDatabases(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawRegisteredAgentDatabase[] {
  const pathname = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (!existsSync(pathname)) {
    if (hasUnavailableMissingSqlitePath(pathname)) {
      throw new Error(`OpenClaw state database ${pathname} is unavailable.`);
    }
    return [];
  }
  if (detectOpenClawStateDatabaseSchemaMigrations(options).length > 0) {
    throw new Error(
      `OpenClaw state database ${pathname} has a legacy agent database registry schema; run openclaw doctor --fix to migrate it.`,
    );
  }

  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(pathname, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    if (readSqliteUserVersion(database) > OPENCLAW_STATE_SCHEMA_VERSION) {
      throw new Error(
        `OpenClaw state database ${pathname} uses a newer schema than this OpenClaw build.`,
      );
    }
    const registryTable = database
      .prepare("SELECT type FROM sqlite_master WHERE name = 'agent_databases'")
      .get() as { type?: unknown } | undefined;
    if (!registryTable) {
      return [];
    }
    if (registryTable.type !== "table") {
      throw new Error(`OpenClaw state database ${pathname} has an invalid agent registry.`);
    }
    const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom("agent_databases")
        .selectAll()
        .orderBy("agent_id", "asc")
        .orderBy("path", "asc"),
    ).rows;
    return rows.map((row) => ({
      agentId: normalizeAgentId(row.agent_id),
      path: row.path,
      schemaVersion: row.schema_version,
      lastSeenAt: row.last_seen_at,
      sizeBytes: row.size_bytes,
    }));
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

export type OpenClawAgentDatabaseOwnerInspection =
  | { status: "owned"; agentId: string }
  | { status: "unowned" }
  | { status: "unreadable" };

/** Read a database's durable role and agent owner without mutating it. */
export function inspectOpenClawAgentDatabaseOwner(
  pathname: string,
): OpenClawAgentDatabaseOwnerInspection {
  const sqlite = requireNodeSqlite();
  let db: DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(pathname, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedAgentSchemaVersion(db, pathname);
    const existing = readExistingSchemaMeta(db);
    if (!existing) {
      return { status: "unowned" };
    }
    if (existing.role !== "agent" || !existing.agentId) {
      return { status: "unreadable" };
    }
    return { status: "owned", agentId: normalizeAgentId(existing.agentId) };
  } catch {
    return { status: "unreadable" };
  } finally {
    db?.close();
  }
}

function assertAgentDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  // Writable open permits interrupted journal recovery. Schema and connection
  // setup must wait until full table/index consistency is proven afterward.
  assertSqliteIntegrity(database, pathname);
}

/** Open or return a cached per-agent database after schema and owner validation. */
export function openOpenClawAgentDatabase(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    if (cached.agentId !== agentId) {
      throw new Error(
        `OpenClaw agent database ${pathname} is already open for agent ${cached.agentId}; requested agent ${agentId}.`,
      );
    }
    return cached;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    cachedDatabases.delete(pathname);
  }

  const openStartedAt = Date.now();
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = (() => {
    let maintenance: SqliteWalMaintenance | undefined;
    try {
      assertAgentDatabaseIntegrityBeforeMutation(db, pathname);
      configureSqlitePreSchemaPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      });
      maintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: `openclaw-agent:${agentId}`,
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      ensureAgentSchema(db, agentId, pathname);
      return maintenance;
    } catch (err) {
      maintenance?.close();
      db.close();
      throw err;
    }
  })();
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  const database = { agentId, db, path: pathname, walMaintenance };
  try {
    registerAgentDatabase({ agentId, path: pathname, env: options.env });
  } catch (error) {
    closeCachedOpenClawAgentDatabase(database);
    throw error;
  }
  cachedDatabases.set(pathname, database);
  // Safety net for processes that end without an orderly close: agent DBs have
  // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
  unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
  logSlowAgentDatabaseOpen({
    agentId,
    elapsedMs: Date.now() - openStartedAt,
    path: pathname,
  });
  return database;
}

/** Run a synchronous immediate transaction against an agent database. */
const postCommitPublications = new WeakMap<OpenClawAgentDatabase, Array<() => void>>();

/** Queue a non-throwing runtime publication on the outer database commit edge. */
export function deferOpenClawAgentPostCommitPublication(
  database: OpenClawAgentDatabase,
  publish: () => void,
): boolean {
  const publications = postCommitPublications.get(database);
  if (!publications) {
    return false;
  }
  publications.push(publish);
  return true;
}

export function runOpenClawAgentWriteTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  const database = openOpenClawAgentDatabase(options);
  const enteredNestedTransaction = database.db.isTransaction;
  const publications: Array<() => void> | undefined = enteredNestedTransaction
    ? postCommitPublications.get(database)
    : [];
  const publicationStart = publications?.length ?? 0;
  if (!enteredNestedTransaction && publications) {
    postCommitPublications.set(database, publications);
  }
  let result: T;
  try {
    result = runSqliteImmediateTransactionSync(
      database.db,
      () => {
        const operationResult = operation(database);
        if (!enteredNestedTransaction) {
          // Permission failure must roll back with the write. Repairing after
          // COMMIT could make callers retry a transaction already durable in SQLite.
          ensureOpenClawAgentDatabasePermissions(database.path, options);
        }
        return operationResult;
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: database.path,
        ...transactionOptions,
        operationLabel: transactionOptions.operationLabel ?? "agent.write",
      },
    );
  } catch (error) {
    publications?.splice(publicationStart);
    throw error;
  } finally {
    if (!enteredNestedTransaction && publications) {
      postCommitPublications.delete(database);
    }
  }
  if (!enteredNestedTransaction) {
    for (const publish of publications ?? []) {
      publish();
    }
  }
  return result;
}

let unregisterExitClose: (() => void) | null = null;

function closeCachedOpenClawAgentDatabase(database: OpenClawAgentDatabase): void {
  database.walMaintenance.close();
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  if (database.db.isOpen) {
    database.db.close();
  }
}

/** Return whether the exact cached agent database pathname is still open. */
export function isOpenClawAgentDatabaseOpen(pathname: string): boolean {
  const database = cachedDatabases.get(path.resolve(pathname));
  return database?.db.isOpen === true;
}

/** Close one cached agent database identified by its exact resolved pathname. */
export function closeOpenClawAgentDatabaseByPath(pathname: string): boolean {
  // Cache keys are lexical resolved paths. Do not realpath aliases here: a
  // symlink swap must never redirect cleanup onto a different cached database.
  const resolvedPath = path.resolve(pathname);
  const database = cachedDatabases.get(resolvedPath);
  if (!database) {
    return false;
  }
  closeCachedOpenClawAgentDatabase(database);
  cachedDatabases.delete(resolvedPath);
  if (cachedDatabases.size === 0) {
    unregisterExitClose?.();
    unregisterExitClose = null;
  }
  return true;
}

/** Close and unregister one transient agent database by exact cached pathname. */
export function disposeOpenClawAgentDatabaseByPath(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  // Require the cache's exact lexical owner. Following a symlink or accepting
  // an uncached path could unregister a database another process now owns.
  const resolvedPath = path.resolve(pathname);
  const database = cachedDatabases.get(resolvedPath);
  if (!database || database.path !== resolvedPath) {
    return false;
  }
  try {
    unregisterAgentDatabase({
      agentId: database.agentId,
      path: resolvedPath,
      ...(options.env ? { env: options.env } : {}),
    });
  } finally {
    // Secret-bearing transient DBs must close even when registry maintenance
    // fails; Windows otherwise cannot remove the file during caller cleanup.
    closeOpenClawAgentDatabaseByPath(resolvedPath);
  }
  return true;
}

/** Close all cached agent database handles. */
export function closeOpenClawAgentDatabases(): void {
  unregisterExitClose?.();
  unregisterExitClose = null;
  for (const database of cachedDatabases.values()) {
    closeCachedOpenClawAgentDatabase(database);
  }
  cachedDatabases.clear();
}

/** Test alias for closing cached agent database handles from teardown code. */
export const closeOpenClawAgentDatabasesForTest = closeOpenClawAgentDatabases;
