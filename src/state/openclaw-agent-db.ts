// OpenClaw agent database stores agent-scoped persisted runtime state.
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { normalizeAgentId } from "../routing/session-key.js";
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
export const OPENCLAW_AGENT_SCHEMA_VERSION = 1;
const OPENCLAW_AGENT_DB_DIR_MODE = 0o700;
const OPENCLAW_AGENT_DB_FILE_MODE = 0o600;

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
};

function assertSupportedAgentSchemaVersion(db: DatabaseSync, pathname: string): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${pathname} uses newer schema version ${userVersion}; this OpenClaw build supports ${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
    );
  }
}

function ensureOpenClawAgentDatabasePermissions(
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
    .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
    .get() as { agent_id?: unknown; role?: unknown } | undefined;
  if (!row) {
    return null;
  }
  return {
    agentId: typeof row.agent_id === "string" ? row.agent_id : null,
    role: typeof row.role === "string" ? row.role : null,
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

function ensureAgentSchema(db: DatabaseSync, agentId: string, pathname: string): void {
  assertSupportedAgentSchemaVersion(db, pathname);
  assertExistingSchemaOwner(readExistingSchemaMeta(db), agentId, pathname);
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
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
    registerAgentDatabase({ agentId, path: pathname, env: options.env });
    return cached;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    cachedDatabases.delete(pathname);
  }

  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = (() => {
    let maintenance: SqliteWalMaintenance | undefined;
    try {
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
  cachedDatabases.set(pathname, database);
  // Safety net for processes that end without an orderly close: agent DBs have
  // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
  unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
  registerAgentDatabase({ agentId, path: pathname, env: options.env });
  return database;
}

/** Run a synchronous immediate transaction against an agent database. */
export function runOpenClawAgentWriteTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
): T {
  const database = openOpenClawAgentDatabase(options);
  const result = runSqliteImmediateTransactionSync(database.db, () => operation(database));
  ensureOpenClawAgentDatabasePermissions(database.path, options);
  return result;
}

let unregisterExitClose: (() => void) | null = null;

/** Close all cached agent database handles. */
export function closeOpenClawAgentDatabases(): void {
  unregisterExitClose?.();
  unregisterExitClose = null;
  for (const database of cachedDatabases.values()) {
    database.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    if (database.db.isOpen) {
      database.db.close();
    }
  }
  cachedDatabases.clear();
}

/** Test alias for closing cached agent database handles from teardown code. */
export const closeOpenClawAgentDatabasesForTest = closeOpenClawAgentDatabases;
