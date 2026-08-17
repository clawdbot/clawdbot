/**
 * SQLite persistence adapter for auth profile secrets and runtime state.
 * The public helpers expose raw JSON payloads so normalization stays in the
 * store/state layers that own compatibility rules.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../../infra/sqlite-files.js";
import { readSqliteUserVersion } from "../../infra/sqlite-user-version.js";
import { registerSqliteCacheExitClose } from "../../infra/sqlite-wal.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  deferOpenClawAgentPostCommitPublication,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveUserPath } from "../../utils.js";
import { resolveRegisteredAgentIdForDir } from "../agent-dir-registry.js";
import { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";

type AgentAuthProfileDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
type SharedAuthProfileDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "auth_profile_stores" | "auth_profile_state"
>;
export type AuthProfileDatabase = OpenClawAgentDatabase | OpenClawStateDatabase;

type AuthProfileDatabaseTarget =
  | { kind: "agent"; agentId: string; path: string; env: NodeJS.ProcessEnv }
  | { kind: "shared-state"; path: string; env: NodeJS.ProcessEnv };

// Auth profiles store one JSON blob for secrets and one JSON blob for runtime
// state. SQLite owns durability/transactions; JSON shape owns compatibility.
const PRIMARY_ROW_KEY = "primary";
const SHARED_ROW_KEY = "shared";
const AUTH_PROFILE_READ_HANDLE_CAP = 8;
const authProfileReadDatabases = new Map<string, DatabaseSync>();
const sharedAuthPostCommitPublications = new WeakMap<OpenClawStateDatabase, Array<() => void>>();
let unregisterReadHandleExitClose: (() => void) | null = null;

type AuthProfileReadPoolCloseScope =
  | { kind: "database"; databasePath: string }
  | { kind: "root"; rootPath: string };

/** Queue runtime publication on the transaction edge owned by this database. */
export function deferAuthProfilePostCommitPublication(
  database: AuthProfileDatabase,
  publish: () => void,
): boolean {
  if ("agentId" in database) {
    return deferOpenClawAgentPostCommitPublication(database, publish);
  }
  const publications = sharedAuthPostCommitPublications.get(database);
  if (!publications) {
    return false;
  }
  publications.push(publish);
  return true;
}

function inferAgentIdFromDir(agentDir: string): string {
  const normalized = path.normalize(agentDir);
  if (path.basename(normalized) === "agent") {
    const parent = path.basename(path.dirname(normalized));
    if (parent) {
      return parent;
    }
  }
  return `custom-${sha256HexPrefixCore(normalized, 12)}`;
}

// The auth database lives in the agent dir and shares the openclaw-agent schema
// so auth store/state can move with the rest of agent-local durable state.
function resolveAuthProfileDatabaseOptions(
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileDatabaseTarget {
  if (!agentDir) {
    const pathname = resolveSharedAuthStorePath(env);
    if (resolveSharedAuthStoreOwnership(env).location === "state-db") {
      return { kind: "shared-state", path: pathname, env };
    }
    const dir = path.dirname(pathname);
    return {
      kind: "agent",
      agentId: resolveRegisteredAgentIdForDir(dir) ?? inferAgentIdFromDir(dir),
      path: pathname,
      env,
    };
  }
  const dir = resolveUserPath(agentDir);
  return {
    kind: "agent",
    agentId: resolveRegisteredAgentIdForDir(dir) ?? inferAgentIdFromDir(dir),
    path: path.join(dir, "openclaw-agent.sqlite"),
    env,
  };
}

/** Resolves the SQLite database path that stores auth profiles for an agent dir. */
export function resolveAuthProfileDatabasePath(agentDir: string): string {
  return resolveAuthProfileDatabaseOptions(agentDir).path;
}

/** Resolves the durable agent owner expected for an auth-profile database. */
export function resolveAuthProfileDatabaseOwnerId(agentDir: string): string {
  const target = resolveAuthProfileDatabaseOptions(agentDir);
  if (target.kind !== "agent") {
    throw new Error("agent auth database unexpectedly resolved to shared state");
  }
  return target.agentId;
}

/** Resolves the SQLite database and sidecar paths used by auth profiles. */
export function resolveAuthProfileDatabaseFilePaths(agentDir: string): string[] {
  return resolveSqliteDatabaseFilePaths(resolveAuthProfileDatabasePath(agentDir));
}

// Read-only probes must tolerate old/corrupt/missing rows. Coercion happens
// above this layer; this layer only returns raw JSON-ish payloads.
function parseJsonCell(raw: string | null | undefined): unknown {
  if (!raw) {
    return null;
  }
  return safeParseJson(raw) ?? null;
}

type PersistedAuthProfileStoreInspection =
  | { status: "missing"; reason: "database" | "table" | "row" }
  | { status: "readable"; raw: unknown }
  | { status: "unreadable" };

function getAgentAuthProfileKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AgentAuthProfileDatabase>(db);
}

function getSharedAuthProfileKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SharedAuthProfileDatabase>(db);
}

function resolveAuthProfileDatabaseKind(
  agentDir: string | undefined,
  database?: Pick<AuthProfileDatabase, "db">,
): AuthProfileDatabaseTarget["kind"] {
  return agentDir !== undefined
    ? "agent"
    : database && !("agentId" in database)
      ? "shared-state"
      : resolveAuthProfileDatabaseOptions(agentDir).kind;
}

function inspectAuthProfileTable(
  db: DatabaseSync,
  target: "store" | "state",
  databaseKind: AuthProfileDatabaseTarget["kind"],
): PersistedAuthProfileStoreInspection | null {
  const tableName =
    target === "store" && databaseKind === "shared-state"
      ? "auth_profile_stores"
      : target === "store"
        ? "auth_profile_store"
        : "auth_profile_state";
  const schemaObject = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get(tableName) as { type?: unknown } | undefined;
  if (!schemaObject) {
    // Agent databases shipped before SQLite auth storage do not have these
    // additive tables until their next writable bootstrap.
    return { status: "missing", reason: "table" };
  }
  return schemaObject.type === "table" ? null : { status: "unreadable" };
}

function inspectAuthProfileJsonCell(
  db: DatabaseSync,
  target: "store" | "state",
  databaseKind: AuthProfileDatabaseTarget["kind"],
): PersistedAuthProfileStoreInspection {
  const tableInspection = inspectAuthProfileTable(db, target, databaseKind);
  if (tableInspection) {
    return tableInspection;
  }
  let raw: string;
  if (databaseKind === "shared-state" && target === "store") {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getSharedAuthProfileKysely(db)
        .selectFrom("auth_profile_stores")
        .select("store_json")
        .where("store_key", "=", SHARED_ROW_KEY),
    );
    if (!row) {
      return { status: "missing", reason: "row" };
    }
    raw = row.store_json;
  } else if (databaseKind === "shared-state") {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getSharedAuthProfileKysely(db)
        .selectFrom("auth_profile_state")
        .select("state_json")
        .where("store_key", "=", SHARED_ROW_KEY),
    );
    if (!row) {
      return { status: "missing", reason: "row" };
    }
    raw = row.state_json;
  } else if (target === "store") {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getAgentAuthProfileKysely(db)
        .selectFrom("auth_profile_store")
        .select("store_json")
        .where("store_key", "=", PRIMARY_ROW_KEY),
    );
    if (!row) {
      return { status: "missing", reason: "row" };
    }
    raw = row.store_json;
  } else {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getAgentAuthProfileKysely(db)
        .selectFrom("auth_profile_state")
        .select("state_json")
        .where("state_key", "=", PRIMARY_ROW_KEY),
    );
    if (!row) {
      return { status: "missing", reason: "row" };
    }
    raw = row.state_json;
  }
  try {
    return { status: "readable", raw: JSON.parse(raw) as unknown };
  } catch {
    return { status: "unreadable" };
  }
}

function closeAuthProfileReadDatabase(databasePath: string): void {
  const pathname = path.resolve(databasePath);
  const db = authProfileReadDatabases.get(pathname);
  if (!db) {
    return;
  }
  authProfileReadDatabases.delete(pathname);
  clearNodeSqliteKyselyCacheForDatabase(db);
  if (db.isOpen) {
    db.close();
  }
  if (authProfileReadDatabases.size === 0) {
    unregisterReadHandleExitClose?.();
    unregisterReadHandleExitClose = null;
  }
}

/** Internal lifecycle close for scoped or all process-local pooled auth-profile readers. */
export function closeAuthProfileReadPool(scope?: AuthProfileReadPoolCloseScope): void {
  if (scope?.kind === "database") {
    closeAuthProfileReadDatabase(scope.databasePath);
    return;
  }
  if (scope?.kind === "root") {
    for (const pathname of authProfileReadDatabases.keys()) {
      if (isPathInside(scope.rootPath, pathname)) {
        closeAuthProfileReadDatabase(pathname);
      }
    }
    return;
  }
  unregisterReadHandleExitClose?.();
  unregisterReadHandleExitClose = null;
  for (const pathname of authProfileReadDatabases.keys()) {
    closeAuthProfileReadDatabase(pathname);
  }
}

function isMissingDatabasePath(pathname: string): boolean {
  try {
    fs.statSync(pathname);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function acquireAuthProfileReadDatabase(
  pathname: string,
): { status: "missing" } | { status: "unreadable" } | { status: "readable"; db: DatabaseSync } {
  const resolvedPath = path.resolve(pathname);
  const cached = authProfileReadDatabases.get(resolvedPath);
  if (cached?.isOpen) {
    authProfileReadDatabases.delete(resolvedPath);
    authProfileReadDatabases.set(resolvedPath, cached);
    return { status: "readable", db: cached };
  }
  if (cached) {
    closeAuthProfileReadDatabase(resolvedPath);
  }
  while (authProfileReadDatabases.size >= AUTH_PROFILE_READ_HANDLE_CAP) {
    const oldestPath = authProfileReadDatabases.keys().next().value;
    if (oldestPath === undefined) {
      break;
    }
    closeAuthProfileReadDatabase(oldestPath);
  }
  let db: DatabaseSync;
  try {
    db = openNodeSqliteDatabase(resolvedPath, { readOnly: true });
  } catch {
    return isMissingDatabasePath(resolvedPath) ? { status: "missing" } : { status: "unreadable" };
  }
  try {
    enableNodeSqliteKyselyStatementCache(db);
    // The pooled reader bypasses canonical agent DB bootstrap, but it shares
    // the same busy policy and validates the process-stable schema on open.
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    if (readSqliteUserVersion(db) > OPENCLAW_AGENT_SCHEMA_VERSION) {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
      return { status: "unreadable" };
    }
  } catch {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    return { status: "unreadable" };
  }
  authProfileReadDatabases.set(resolvedPath, db);
  unregisterReadHandleExitClose ??= registerSqliteCacheExitClose(closeAuthProfileReadPool);
  return { status: "readable", db };
}

function inspectAuthProfileJsonCellReadOnly(
  databaseTarget: AuthProfileDatabaseTarget,
  target: "store" | "state",
): PersistedAuthProfileStoreInspection {
  if (databaseTarget.kind === "shared-state") {
    try {
      return (
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => inspectAuthProfileJsonCell(db, target, "shared-state"),
          { env: databaseTarget.env, path: databaseTarget.path },
        ) ?? { status: "missing", reason: "database" }
      );
    } catch {
      return isMissingDatabasePath(databaseTarget.path)
        ? { status: "missing", reason: "database" }
        : { status: "unreadable" };
    }
  }
  const acquired = acquireAuthProfileReadDatabase(databaseTarget.path);
  if (acquired.status === "missing") {
    return { status: "missing", reason: "database" };
  }
  if (acquired.status === "unreadable") {
    return { status: "unreadable" };
  }
  try {
    return inspectAuthProfileJsonCell(acquired.db, target, "agent");
  } catch {
    closeAuthProfileReadDatabase(databaseTarget.path);
    return { status: "unreadable" };
  }
}

/** Distinguishes an absent auth row from a present store that could not be read. */
export function inspectPersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: Pick<AuthProfileDatabase, "db">,
): PersistedAuthProfileStoreInspection {
  const databaseTarget = resolveAuthProfileDatabaseOptions(agentDir);
  if (database) {
    return inspectAuthProfileJsonCell(
      database.db,
      "store",
      resolveAuthProfileDatabaseKind(agentDir, database),
    );
  }
  return inspectAuthProfileJsonCellReadOnly(databaseTarget, "store");
}

/** Distinguishes an absent auth-state row from state that could not be read. */
export function inspectPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: Pick<AuthProfileDatabase, "db">,
): PersistedAuthProfileStoreInspection {
  const databaseTarget = resolveAuthProfileDatabaseOptions(agentDir);
  if (database) {
    return inspectAuthProfileJsonCell(
      database.db,
      "state",
      resolveAuthProfileDatabaseKind(agentDir, database),
    );
  }
  return inspectAuthProfileJsonCellReadOnly(databaseTarget, "state");
}

/** Inspect the shared store for an explicit state root without projecting it to an agent dir. */
export function inspectPersistedSharedAuthProfileStoreRaw(
  env: NodeJS.ProcessEnv,
): PersistedAuthProfileStoreInspection {
  return inspectAuthProfileJsonCellReadOnly(
    resolveAuthProfileDatabaseOptions(undefined, env),
    "store",
  );
}

/** Inspect shared runtime state for an explicit state root. */
export function inspectPersistedSharedAuthProfileStateRaw(
  env: NodeJS.ProcessEnv,
): PersistedAuthProfileStoreInspection {
  return inspectAuthProfileJsonCellReadOnly(
    resolveAuthProfileDatabaseOptions(undefined, env),
    "state",
  );
}

/** Reads the raw persisted secrets-store payload without coercing the schema. */
export function readPersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): unknown {
  const databaseTarget = resolveAuthProfileDatabaseOptions(agentDir);
  if (database) {
    if (resolveAuthProfileDatabaseKind(agentDir, database) === "shared-state") {
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        getSharedAuthProfileKysely(database.db)
          .selectFrom("auth_profile_stores")
          .select("store_json")
          .where("store_key", "=", SHARED_ROW_KEY),
      );
      return parseJsonCell(row?.store_json);
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getAgentAuthProfileKysely(database.db)
        .selectFrom("auth_profile_store")
        .select("store_json")
        .where("store_key", "=", PRIMARY_ROW_KEY),
    );
    return parseJsonCell(row?.store_json);
  }
  const result = inspectAuthProfileJsonCellReadOnly(databaseTarget, "store");
  return result.status === "readable" ? result.raw : null;
}

/** Reads the raw persisted runtime-state payload without coercing the schema. */
export function readPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): unknown {
  const databaseTarget = resolveAuthProfileDatabaseOptions(agentDir);
  if (database) {
    if (resolveAuthProfileDatabaseKind(agentDir, database) === "shared-state") {
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        getSharedAuthProfileKysely(database.db)
          .selectFrom("auth_profile_state")
          .select("state_json")
          .where("store_key", "=", SHARED_ROW_KEY),
      );
      return parseJsonCell(row?.state_json);
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getAgentAuthProfileKysely(database.db)
        .selectFrom("auth_profile_state")
        .select("state_json")
        .where("state_key", "=", PRIMARY_ROW_KEY),
    );
    return parseJsonCell(row?.state_json);
  }
  const result = inspectAuthProfileJsonCellReadOnly(databaseTarget, "state");
  return result.status === "readable" ? result.raw : null;
}

/** Read the shared credential row for an explicit state root. */
export function readPersistedSharedAuthProfileStoreRaw(env: NodeJS.ProcessEnv): unknown {
  const result = inspectPersistedSharedAuthProfileStoreRaw(env);
  return result.status === "readable" ? result.raw : null;
}

/** Read the shared runtime-state row for an explicit state root. */
export function readPersistedSharedAuthProfileStateRaw(env: NodeJS.ProcessEnv): unknown {
  const result = inspectPersistedSharedAuthProfileStateRaw(env);
  return result.status === "readable" ? result.raw : null;
}

/** Writes the raw persisted secrets-store payload inside the auth database. */
export function writePersistedAuthProfileStoreRaw(
  payload: unknown,
  agentDir?: string,
  database?: AuthProfileDatabase,
): void {
  const databaseKind = resolveAuthProfileDatabaseKind(agentDir, database);
  const write = (target: AuthProfileDatabase) => {
    if (databaseKind === "shared-state") {
      executeSqliteQuerySync(
        target.db,
        getSharedAuthProfileKysely(target.db)
          .insertInto("auth_profile_stores")
          .values({
            store_key: SHARED_ROW_KEY,
            store_json: JSON.stringify(payload),
            updated_at: Date.now(),
          })
          .onConflict((conflict) =>
            conflict.column("store_key").doUpdateSet({
              store_json: JSON.stringify(payload),
              updated_at: Date.now(),
            }),
          ),
      );
      return;
    }
    executeSqliteQuerySync(
      target.db,
      getAgentAuthProfileKysely(target.db)
        .insertInto("auth_profile_store")
        .values({
          store_key: PRIMARY_ROW_KEY,
          store_json: JSON.stringify(payload),
          updated_at: Date.now(),
        })
        .onConflict((conflict) =>
          conflict.column("store_key").doUpdateSet({
            store_json: JSON.stringify(payload),
            updated_at: Date.now(),
          }),
        ),
    );
  };
  if (database) {
    write(database);
    return;
  }
  runAuthProfileWriteTransaction(agentDir, write);
}

/** Deletes the persisted secrets-store row while leaving runtime state intact. */
export function deletePersistedAuthProfileStoreRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): void {
  const databaseKind = resolveAuthProfileDatabaseKind(agentDir, database);
  const remove = (target: AuthProfileDatabase) => {
    executeSqliteQuerySync(
      target.db,
      databaseKind === "shared-state"
        ? getSharedAuthProfileKysely(target.db)
            .deleteFrom("auth_profile_stores")
            .where("store_key", "=", SHARED_ROW_KEY)
        : getAgentAuthProfileKysely(target.db)
            .deleteFrom("auth_profile_store")
            .where("store_key", "=", PRIMARY_ROW_KEY),
    );
  };
  if (database) {
    remove(database);
    return;
  }
  runAuthProfileWriteTransaction(agentDir, remove);
}

/** Writes or deletes the persisted runtime-state payload. */
export function writePersistedAuthProfileStateRaw(
  payload: unknown,
  agentDir?: string,
  database?: AuthProfileDatabase,
): void {
  const databaseKind = resolveAuthProfileDatabaseKind(agentDir, database);
  const write = (target: AuthProfileDatabase) => {
    if (databaseKind === "shared-state") {
      const db = getSharedAuthProfileKysely(target.db);
      if (!payload) {
        executeSqliteQuerySync(
          target.db,
          db.deleteFrom("auth_profile_state").where("store_key", "=", SHARED_ROW_KEY),
        );
        return;
      }
      executeSqliteQuerySync(
        target.db,
        db
          .insertInto("auth_profile_state")
          .values({
            store_key: SHARED_ROW_KEY,
            state_json: JSON.stringify(payload),
            updated_at: Date.now(),
          })
          .onConflict((conflict) =>
            conflict.column("store_key").doUpdateSet({
              state_json: JSON.stringify(payload),
              updated_at: Date.now(),
            }),
          ),
      );
      return;
    }
    const db = getAgentAuthProfileKysely(target.db);
    if (!payload) {
      executeSqliteQuerySync(
        target.db,
        db.deleteFrom("auth_profile_state").where("state_key", "=", PRIMARY_ROW_KEY),
      );
      return;
    }
    executeSqliteQuerySync(
      target.db,
      db
        .insertInto("auth_profile_state")
        .values({
          state_key: PRIMARY_ROW_KEY,
          state_json: JSON.stringify(payload),
          updated_at: Date.now(),
        })
        .onConflict((conflict) =>
          conflict.column("state_key").doUpdateSet({
            state_json: JSON.stringify(payload),
            updated_at: Date.now(),
          }),
        ),
    );
  };
  if (database) {
    write(database);
    return;
  }
  runAuthProfileWriteTransaction(agentDir, write);
}

/** Runs an auth-profile database write transaction for store/state updates. */
export function runAuthProfileWriteTransaction<T>(
  agentDir: string | undefined,
  operation: (database: AuthProfileDatabase) => T,
  options: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): T {
  const env =
    options.env ??
    (options.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: options.stateDir } : process.env);
  const databaseTarget = resolveAuthProfileDatabaseOptions(agentDir, env);
  if (databaseTarget.kind === "agent") {
    return runOpenClawAgentWriteTransaction(operation, databaseTarget);
  }

  const database = openOpenClawStateDatabase({ env, path: databaseTarget.path });
  const enteredNestedTransaction = database.db.isTransaction;
  const publications: Array<() => void> | undefined = enteredNestedTransaction
    ? sharedAuthPostCommitPublications.get(database)
    : [];
  const publicationStart = publications?.length ?? 0;
  if (!enteredNestedTransaction && publications) {
    sharedAuthPostCommitPublications.set(database, publications);
  }
  let result: T;
  try {
    result = runOpenClawStateWriteTransaction(operation, { env, database });
  } catch (error) {
    publications?.splice(publicationStart);
    throw error;
  } finally {
    if (!enteredNestedTransaction && publications) {
      sharedAuthPostCommitPublications.delete(database);
    }
  }
  if (!enteredNestedTransaction) {
    for (const publish of publications ?? []) {
      publish();
    }
  }
  return result;
}
