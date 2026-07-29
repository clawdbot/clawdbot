import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_CHUNK_PROVENANCE_TRIGGER_DEFINITIONS,
} from "../../packages/memory-host-sdk/src/host/memory-schema-provenance.js";
import {
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
} from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { repairCanonicalSqliteIndexes } from "../infra/sqlite-index-schema.js";
import {
  assertSqliteSchemaContains,
  assertSqliteSchemaTablesPresent,
  getCanonicalSqliteTableNames,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AGENT_V14_BOARD_SCHEMA_SQL,
  ensureOpenClawAgentBoardSchemaInTransaction,
} from "./openclaw-agent-board-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";
import {
  AGENT_V14_ADDITIVE_SCHEMA_SQL,
  AGENT_V14_CORE_SCHEMA_SQL,
  AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
} from "./openclaw-agent-session-sharing-schema.js";
import {
  STANDING_INTENTS_FTS_SHADOW_TABLES,
  STANDING_INTENTS_FTS_TABLE,
  STANDING_INTENTS_TABLE,
} from "./openclaw-agent-standing-intents-schema.js";

type ExistingAgentSchemaMeta = {
  agentId: string | null;
  role: string | null;
  schemaVersion: number | null;
};

const AGENT_SCHEMA_COMPATIBILITY = {
  allowedMissingTables: [
    MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
    STANDING_INTENTS_TABLE,
    STANDING_INTENTS_FTS_TABLE,
    ...STANDING_INTENTS_FTS_SHADOW_TABLES,
  ],
  // Older agent DBs lack the additive recall metadata columns; memory-core's
  // lazy ensure ALTERs them in on first memory use, so accept their absence here
  // or every existing deployment fails doctor and rolls back its update.
  allowedMissingColumns: [
    "standing_intents.creator_sender",
    "memory_index_chunks.importance",
    "memory_index_chunks.triggers",
    "memory_index_chunks.project_key",
  ],
  allowedColumnDefinitions: {
    "conversations.delivery_target": ["delivery_target TEXT NOT NULL DEFAULT ''"],
  },
  optionalCanonicalTriggerGroups: [
    {
      optionalWhenTableMissing: MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
      tableName: MEMORY_INDEX_CHUNKS_TABLE,
      triggers: MEMORY_INDEX_CHUNK_PROVENANCE_TRIGGER_DEFINITIONS,
    },
    {
      tableName: MEMORY_INDEX_SOURCES_TABLE,
      triggers: MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
    },
  ],
} satisfies SqliteSchemaCompatibility;

export function assertOpenClawAgentSchemaContains(
  database: DatabaseSync,
  pathname: string,
  schemaSql: string,
): void {
  assertSqliteSchemaContains(database, pathname, schemaSql, AGENT_SCHEMA_COMPATIBILITY);
}

export function assertOpenClawAgentCurrentRuntimeSchema(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${OPENCLAW_AGENT_SCHEMA_VERSION}; run openclaw doctor --fix before using it.`,
    );
  }
  assertOpenClawAgentSchemaContains(database, options.pathname, OPENCLAW_AGENT_SCHEMA_SQL);
}

function hasAnyCanonicalTable(database: DatabaseSync, schemaSql: string): boolean {
  const tableNames = getCanonicalSqliteTableNames(schemaSql);
  const placeholders = tableNames.map(() => "?").join(", ");
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM main.sqlite_schema
         WHERE type = 'table' AND name IN (${placeholders})
         LIMIT 1`,
      )
      .get(...tableNames),
  );
}

function repairAndAssertAgentSchemaGroup(
  database: DatabaseSync,
  pathname: string,
  schemaSql: string,
): void {
  repairCanonicalSqliteIndexes(database, pathname, schemaSql, {
    verifyPhysicalIntegrity: false,
  });
  assertOpenClawAgentSchemaContains(database, pathname, schemaSql);
}

export function repairAndAssertOpenClawAgentV14SchemaForMigration(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion !== 14) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} uses schema version ${userVersion}; expected 14 before migrating it.`,
    );
  }
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.schemaVersion !== 14) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match 14; repair the ownership metadata before migrating it.`,
    );
  }

  // v14 always owned the core schema. Board and collaboration groups were
  // lazy, but a partially present group still has to be complete and canonical.
  repairAndAssertAgentSchemaGroup(database, options.pathname, AGENT_V14_CORE_SCHEMA_SQL);
  if (hasAnyCanonicalTable(database, AGENT_V14_SESSION_SHARING_SCHEMA_SQL)) {
    repairAndAssertAgentSchemaGroup(
      database,
      options.pathname,
      AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
    );
  }
  if (hasAnyCanonicalTable(database, AGENT_V14_ADDITIVE_SCHEMA_SQL)) {
    repairAndAssertAgentSchemaGroup(database, options.pathname, AGENT_V14_ADDITIVE_SCHEMA_SQL);
  }
  if (hasAnyCanonicalTable(database, AGENT_V14_BOARD_SCHEMA_SQL)) {
    assertSqliteSchemaTablesPresent(database, options.pathname, AGENT_V14_BOARD_SCHEMA_SQL);
    ensureOpenClawAgentBoardSchemaInTransaction(database);
    repairAndAssertAgentSchemaGroup(database, options.pathname, AGENT_V14_BOARD_SCHEMA_SQL);
  }
}

export function assertSupportedAgentSchemaVersion(db: DatabaseSync, pathname: string): void {
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

/** Refuse steady-state reads until Doctor has completed the v16 media cutover. */
export function assertCanonicalAgentMediaPersistenceVersion(
  db: DatabaseSync,
  pathname: string,
): void {
  const userVersion = readSqliteUserVersion(db);
  const hasApplicationSchema = db
    .prepare("SELECT 1 FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' LIMIT 1")
    .get();
  const isNewUnownedDatabase =
    userVersion === 0 && readExistingAgentSchemaMeta(db) === null && !hasApplicationSchema;
  if (userVersion < OPENCLAW_AGENT_SCHEMA_VERSION && !isNewUnownedDatabase) {
    throw new Error(
      `OpenClaw agent database ${pathname} uses schema version ${userVersion}; run openclaw doctor --fix to migrate persisted media before using it.`,
    );
  }
}

export function readExistingAgentSchemaMeta(db: DatabaseSync): ExistingAgentSchemaMeta | null {
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

export function assertExistingAgentSchemaOwner(
  existing: ExistingAgentSchemaMeta | null,
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
