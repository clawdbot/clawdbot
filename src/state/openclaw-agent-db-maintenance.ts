import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
} from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  assertSqliteSchemaContains,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";

const OPENCLAW_AGENT_MAINTENANCE_SCHEMA_COMPATIBILITY = {
  allowedColumnDefinitions: {
    "conversations.delivery_target": ["delivery_target TEXT NOT NULL DEFAULT ''"],
  },
  optionalCanonicalTriggerGroups: [
    {
      tableName: MEMORY_INDEX_SOURCES_TABLE,
      triggers: MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
    },
  ],
} satisfies SqliteSchemaCompatibility;

/** Require exact agent ownership without requiring the latest schema. */
export function assertOpenClawAgentDatabaseOwner(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): NonNullable<ReturnType<typeof readExistingAgentSchemaMeta>> {
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} belongs to agent ${metadata.agentId}; requested agent ${agentId}.`,
    );
  }
  return metadata;
}

/** Require the exact agent owner and schema before offline file maintenance. */
export function assertOpenClawAgentDatabaseForMaintenance(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const metadata = assertOpenClawAgentDatabaseOwner(database, options);

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
  assertSqliteSchemaContains(
    database,
    options.pathname,
    OPENCLAW_AGENT_SCHEMA_SQL,
    OPENCLAW_AGENT_MAINTENANCE_SCHEMA_COMPATIBILITY,
  );
}

/** Upgrade a supported older owned schema before strict offline maintenance. */
export function migrateOpenClawAgentDatabaseForMaintenance(options: {
  agentId: string;
  pathname: string;
}): void {
  const agentId = normalizeAgentId(options.agentId);
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(options.pathname);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    const metadata = readExistingAgentSchemaMeta(database);
    if (!metadata) {
      return;
    }
    assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
    assertSupportedAgentSchemaVersion(database, options.pathname);
    const userVersion = readSqliteUserVersion(database);
    const metadataVersion = metadata.schemaVersion;
    const hasSupportedOlderVersion =
      userVersion >= 1 &&
      userVersion < OPENCLAW_AGENT_SCHEMA_VERSION &&
      metadataVersion !== null &&
      metadataVersion === userVersion &&
      metadataVersion >= 1 &&
      metadataVersion < OPENCLAW_AGENT_SCHEMA_VERSION;
    if (!hasSupportedOlderVersion) {
      return;
    }
    ensureOpenClawAgentDatabaseSchema(database, {
      agentId,
      path: options.pathname,
    });
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}
