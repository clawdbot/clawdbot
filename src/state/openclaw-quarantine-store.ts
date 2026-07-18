// Dedicated quarantine decisions stay available when primary databases fail.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { VERSION } from "../version.js";
import { resolveOpenClawStateSqliteDir } from "./openclaw-state-db.paths.js";

const OPENCLAW_QUARANTINE_SCHEMA_VERSION = 1;
const OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS = 5_000;
const OPENCLAW_QUARANTINE_DIR_MODE = 0o700;
const OPENCLAW_QUARANTINE_FILE_MODE = 0o600;

type OpenClawDatabaseKind = "agent" | "state";

type OpenClawDatabaseQuarantine = {
  kind: OpenClawDatabaseKind;
  quarantinedAt: number;
  reason: string;
};

function resolveQuarantineStorePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveOpenClawStateSqliteDir(env), "openclaw-quarantine.sqlite");
}

function ensureQuarantineStoreDirectory(storePath: string): void {
  const dir = path.dirname(storePath);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_QUARANTINE_DIR_MODE });
  applyPrivateModeSync(dir, OPENCLAW_QUARANTINE_DIR_MODE);
}

function configureQuarantineWriter(database: DatabaseSync, storePath: string): void {
  database.exec(`
    PRAGMA busy_timeout = ${OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
  `);
  const userVersion = readQuarantineSchemaVersion(database, storePath);
  if (userVersion > OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw quarantine store ${storePath} uses newer schema version ${userVersion}.`,
    );
  }
  if (userVersion === OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
    return;
  }
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS quarantined_databases (
      path TEXT NOT NULL PRIMARY KEY,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at INTEGER NOT NULL,
      writer_app_version TEXT
    ) STRICT;
    PRAGMA user_version = ${OPENCLAW_QUARANTINE_SCHEMA_VERSION};
    COMMIT;
  `);
}

function readQuarantineSchemaVersion(database: DatabaseSync, storePath: string): number {
  const row = database.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  const userVersion = row?.user_version;
  if (typeof userVersion !== "number" || !Number.isInteger(userVersion)) {
    throw new Error(`OpenClaw quarantine store ${storePath} has an invalid schema version.`);
  }
  return userVersion;
}

function withQuarantineWriter<T>(env: NodeJS.ProcessEnv, operation: (db: DatabaseSync) => T): T {
  const storePath = resolveQuarantineStorePath(env);
  const existed = existsSync(storePath);
  ensureQuarantineStoreDirectory(storePath);
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(storePath);
  let completed = false;
  try {
    if (!existed) {
      applyPrivateModeSync(storePath, OPENCLAW_QUARANTINE_FILE_MODE);
    }
    configureQuarantineWriter(database, storePath);
    const result = operation(database);
    completed = true;
    return result;
  } finally {
    database.close();
    if (completed || !existed) {
      applyPrivateModeSync(storePath, OPENCLAW_QUARANTINE_FILE_MODE);
    }
  }
}

/** Read one authoritative quarantine decision without creating the store. */
export function readOpenClawDatabaseQuarantine(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): OpenClawDatabaseQuarantine | undefined {
  const storePath = resolveQuarantineStorePath(options.env ?? process.env);
  // Clean installs pay one existence check. No directory or SQLite work.
  if (!existsSync(storePath)) {
    return undefined;
  }
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(storePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_QUARANTINE_BUSY_TIMEOUT_MS};`);
    const userVersion = readQuarantineSchemaVersion(database, storePath);
    if (userVersion === 0) {
      return undefined;
    }
    if (userVersion !== OPENCLAW_QUARANTINE_SCHEMA_VERSION) {
      throw new Error(
        `OpenClaw quarantine store ${storePath} uses newer schema version ${userVersion}.`,
      );
    }
    const row = database
      .prepare(
        "SELECT kind, reason, quarantined_at FROM quarantined_databases WHERE path = ? LIMIT 1",
      )
      .get(path.resolve(pathname)) as
      | { kind?: unknown; quarantined_at?: unknown; reason?: unknown }
      | undefined;
    if (!row) {
      return undefined;
    }
    if (
      (row.kind !== "agent" && row.kind !== "state") ||
      typeof row.reason !== "string" ||
      typeof row.quarantined_at !== "number" ||
      !Number.isInteger(row.quarantined_at)
    ) {
      throw new Error(`OpenClaw quarantine store ${storePath} contains an invalid row.`);
    }
    return { kind: row.kind, quarantinedAt: row.quarantined_at, reason: row.reason };
  } finally {
    database.close();
  }
}

/** Persist one authoritative quarantine decision. */
export function recordOpenClawDatabaseQuarantine(options: {
  env?: NodeJS.ProcessEnv;
  kind: OpenClawDatabaseKind;
  path: string;
  reason: string;
}): boolean {
  try {
    return withQuarantineWriter(options.env ?? process.env, (database) => {
      database.exec("BEGIN IMMEDIATE;");
      try {
        database
          .prepare(
            `
              INSERT INTO quarantined_databases (
                path, kind, reason, quarantined_at, writer_app_version
              ) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                kind = excluded.kind,
                reason = excluded.reason,
                quarantined_at = excluded.quarantined_at,
                writer_app_version = excluded.writer_app_version
            `,
          )
          .run(path.resolve(options.path), options.kind, options.reason, Date.now(), VERSION);
        database.exec("COMMIT;");
        return true;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    });
  } catch {
    return false;
  }
}

/** Clear one authoritative quarantine decision. */
export function clearOpenClawDatabaseQuarantine(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = options.env ?? process.env;
  if (!existsSync(resolveQuarantineStorePath(env))) {
    return true;
  }
  try {
    return withQuarantineWriter(env, (database) => {
      database.exec("BEGIN IMMEDIATE;");
      try {
        database
          .prepare("DELETE FROM quarantined_databases WHERE path = ?")
          .run(path.resolve(pathname));
        database.exec("COMMIT;");
        return true;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    });
  } catch {
    return false;
  }
}
