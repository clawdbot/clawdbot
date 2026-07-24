import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteSchemaContains,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.generated.js";

const OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY = {
  allowedColumnDefinitions: {
    "diagnostic_events.sequence": ["sequence INTEGER NOT NULL DEFAULT 0"],
    "commitments.attempts": ["attempts INTEGER NOT NULL DEFAULT 0"],
    "commitments.confidence": ["confidence REAL NOT NULL DEFAULT 0"],
    "commitments.created_at_ms": ["created_at_ms INTEGER NOT NULL DEFAULT 0"],
    "commitments.dedupe_key": ["dedupe_key TEXT NOT NULL DEFAULT ''"],
    "commitments.due_timezone": ["due_timezone TEXT NOT NULL DEFAULT 'UTC'"],
    "commitments.kind": ["kind TEXT NOT NULL DEFAULT 'followup'"],
    "commitments.reason": ["reason TEXT NOT NULL DEFAULT ''"],
    "commitments.sensitivity": ["sensitivity TEXT NOT NULL DEFAULT 'normal'"],
    "commitments.source": ["source TEXT NOT NULL DEFAULT 'unknown'"],
    "commitments.suggested_text": ["suggested_text TEXT NOT NULL DEFAULT ''"],
    "cron_jobs.created_at_ms": ["created_at_ms INTEGER NOT NULL DEFAULT 0"],
    "cron_jobs.enabled": ["enabled INTEGER NOT NULL DEFAULT 1"],
    "cron_jobs.name": ["name TEXT NOT NULL DEFAULT ''"],
    "cron_jobs.payload_kind": ["payload_kind TEXT NOT NULL DEFAULT 'message'"],
    "cron_jobs.schedule_kind": ["schedule_kind TEXT NOT NULL DEFAULT 'manual'"],
    "cron_jobs.session_target": ["session_target TEXT NOT NULL DEFAULT 'main'"],
    "cron_jobs.wake_mode": ["wake_mode TEXT NOT NULL DEFAULT 'auto'"],
    "current_conversation_bindings.conversation_kind": [
      "conversation_kind TEXT NOT NULL DEFAULT 'channel'",
    ],
    "current_conversation_bindings.target_agent_id": [
      "target_agent_id TEXT NOT NULL DEFAULT 'main'",
    ],
  },
} satisfies SqliteSchemaCompatibility;

/** Open shared SQLite database handle plus WAL maintenance lifecycle. */

export function createOpenClawDatabaseVerificationError(
  kind: "agent" | "state",
  pathname: string,
  storedError: string | null,
): Error {
  // Doctor's clearing hooks run after a full integrity assertion, so a still-
  // corrupt file cannot be cleared directly: the file must be healthy first.
  const error = new Error(
    `OpenClaw ${kind} database ${pathname} is quarantined after integrity verification failed: ${storedError ?? "unknown integrity error"}. Restore the database from a backup or repair it, then run openclaw doctor --fix to clear the quarantine. See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
  );
  error.name = "SqliteIntegrityError";
  return error;
}

export function assertSupportedSchemaVersion(db: DatabaseSync, pathname: string): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      pathname,
      userVersion,
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
  }
}

/** Require canonical shared-state ownership without requiring the latest schema. */
export function assertOpenClawStateDatabaseOwner(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  const hasMetadataTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta' LIMIT 1")
    .get();
  const metadata = hasMetadataTable
    ? (database.prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary' LIMIT 1").get() as
        | { role?: unknown }
        | undefined)
    : undefined;
  if (metadata?.role !== "global") {
    const role = typeof metadata?.role === "string" ? metadata.role : "missing";
    throw new Error(
      `OpenClaw state database ${options.pathname} has schema role ${role}; expected global.`,
    );
  }
}

/** Require the canonical shared-state owner and schema before offline file maintenance. */
export function assertOpenClawStateDatabaseForMaintenance(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      options.pathname,
      userVersion,
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
  }
  if (userVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw state database ${options.pathname} uses schema version ${userVersion}; run openclaw doctor --fix before compacting it.`,
    );
  }

  assertOpenClawStateDatabaseOwner(database, options);
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { schema_version?: unknown } | undefined;
  if (metadata?.schema_version !== OPENCLAW_STATE_SCHEMA_VERSION) {
    const schemaVersion =
      typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid";
    throw new Error(
      `OpenClaw state database ${options.pathname} metadata schema version ${schemaVersion} does not match ${OPENCLAW_STATE_SCHEMA_VERSION}; run openclaw doctor --fix before compacting it.`,
    );
  }
  assertSqliteSchemaContains(
    database,
    options.pathname,
    OPENCLAW_STATE_SCHEMA_SQL,
    OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
  );
}

export function resolveDatabasePath(options: OpenClawStateDatabaseOptions = {}): string {
  return path.resolve(options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env));
}
