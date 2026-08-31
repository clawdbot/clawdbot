/**
 * SQLite persistence adapter for auth profile secrets and runtime state.
 * The public helpers expose raw JSON payloads so normalization stays in the
 * store/state layers that own compatibility rules.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { resolveStateDir } from "../../config/paths.js";
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
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
  type SharedAuthStoreOwnership,
} from "./path-resolve.js";
import { prepareFreshSharedAuthStoreWrite } from "./shared-store-bootstrap.js";

type AgentAuthProfileDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
type SharedAuthProfileDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;
export type AuthProfileDatabase = OpenClawAgentDatabase | OpenClawStateDatabase;

/** Internal prepared ownership, carried through commit publication and compensation. */
export type AuthProfileStoreOwner = {
  databasePath: string;
  sharedDatabasePath: string;
  location: SharedAuthStoreOwnership["location"];
};

export type PreparedAuthProfileStoreOwner = AuthProfileStoreOwner & { env: NodeJS.ProcessEnv };

export function resolveAuthProfileStoreOwner(
  database: AuthProfileDatabase,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileStoreOwner | PreparedAuthProfileStoreOwner {
  const prepared = authProfileTransactions.get(database)?.owner;
  if (prepared) {
    return prepared;
  }
  // A supplied shared connection already names its owner; ambient discovery can
  // select another database (or fail on it) before this connection is ever used.
  if (!("agentId" in database)) {
    return { databasePath: database.path, sharedDatabasePath: database.path, location: "state-db" };
  }
  return {
    ...prepareAuthProfileSharedOwner(env),
    databasePath: database.path,
  };
}

function prepareAuthProfileSharedOwner(env: NodeJS.ProcessEnv) {
  const preparedEnv = { ...env, OPENCLAW_STATE_DIR: resolveStateDir(env) };
  return {
    env: preparedEnv,
    sharedDatabasePath: resolveSharedAuthStorePath(preparedEnv),
    location: resolveSharedAuthStoreOwnership(preparedEnv).location,
  };
}

type AuthProfileDatabaseTarget =
  | { kind: "agent"; agentId: string; path: string; env: NodeJS.ProcessEnv }
  | { kind: "shared-state"; path: string; env: NodeJS.ProcessEnv };

// Auth profiles store one JSON blob for secrets and one JSON blob for runtime
// state. SQLite owns durability/transactions; JSON shape owns compatibility.
const PRIMARY_ROW_KEY = "primary";
// Shared-state auth payloads live in config_machine_state; the keys are listed
// in STATE_SECRET_CONFIG_STATE_KEY_PREFIXES so git backups never carry them.
const SHARED_STORE_STATE_KEY = "authProfiles.store";
const SHARED_STATE_STATE_KEY = "authProfiles.state";

// These run inside the module's own transactions; opening another would nest.
function readSharedAuthKvCell(db: DatabaseSync, stateKey: string): string | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSharedAuthProfileKysely(db)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", stateKey),
  );
  return row?.value_json;
}

function writeSharedAuthKvCell(db: DatabaseSync, stateKey: string, valueJson: string): void {
  executeSqliteQuerySync(
    db,
    getSharedAuthProfileKysely(db)
      .insertInto("config_machine_state")
      .values({ state_key: stateKey, value_json: valueJson, updated_at_ms: Date.now() })
      .onConflict((conflict) =>
        conflict
          .column("state_key")
          .doUpdateSet({ value_json: valueJson, updated_at_ms: Date.now() }),
      ),
  );
}

function deleteSharedAuthKvCell(db: DatabaseSync, stateKey: string): void {
  executeSqliteQuerySync(
    db,
    getSharedAuthProfileKysely(db)
      .deleteFrom("config_machine_state")
      .where("state_key", "=", stateKey),
  );
}
const AUTH_PROFILE_READ_HANDLE_CAP = 8;
const authProfileReadDatabases = new Map<string, DatabaseSync>();
const authProfileTransactions = new WeakMap<
  AuthProfileDatabase,
  { owner: PreparedAuthProfileStoreOwner; publications: Array<() => void> }
>();
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
  const publications = authProfileTransactions.get(database)?.publications;
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
  if (database && "agentId" in database) {
    return "agent";
  }
  if (database && "path" in database) {
    return "shared-state";
  }
  return resolveAuthProfileDatabaseOptions(agentDir).kind;
}

function inspectAuthProfileTable(
  db: DatabaseSync,
  target: "store" | "state",
  databaseKind: AuthProfileDatabaseTarget["kind"],
): PersistedAuthProfileStoreInspection | null {
  const tableName =
    databaseKind === "shared-state"
      ? "config_machine_state"
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
  if (databaseKind === "shared-state") {
    const cell = readSharedAuthKvCell(
      db,
      target === "store" ? SHARED_STORE_STATE_KEY : SHARED_STATE_STATE_KEY,
    );
    if (cell === undefined) {
      return { status: "missing", reason: "row" };
    }
    raw = cell;
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
  clearNodeSqliteKyselyCacheForDatabase(db);
  if (db.isOpen) {
    db.close();
  }
  // Failed closes remain owned so scoped disposal can retain the root and retry.
  authProfileReadDatabases.delete(pathname);
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

export function inspectAuthProfileJsonCellReadOnly(
  databaseTarget: Pick<AuthProfileDatabaseTarget, "kind" | "path">,
  target: "store" | "state",
): PersistedAuthProfileStoreInspection {
  if (databaseTarget.kind === "shared-state") {
    try {
      return (
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => inspectAuthProfileJsonCell(db, target, "shared-state"),
          { path: databaseTarget.path },
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
  if (database) {
    return inspectAuthProfileJsonCell(
      database.db,
      "store",
      resolveAuthProfileDatabaseKind(agentDir, database),
    );
  }
  return inspectAuthProfileJsonCellReadOnly(resolveAuthProfileDatabaseOptions(agentDir), "store");
}

/** Distinguishes an absent auth-state row from state that could not be read. */
export function inspectPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: Pick<AuthProfileDatabase, "db">,
): PersistedAuthProfileStoreInspection {
  if (database) {
    return inspectAuthProfileJsonCell(
      database.db,
      "state",
      resolveAuthProfileDatabaseKind(agentDir, database),
    );
  }
  return inspectAuthProfileJsonCellReadOnly(resolveAuthProfileDatabaseOptions(agentDir), "state");
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
  if (database) {
    if (resolveAuthProfileDatabaseKind(agentDir, database) === "shared-state") {
      return parseJsonCell(readSharedAuthKvCell(database.db, SHARED_STORE_STATE_KEY));
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
  const result = inspectAuthProfileJsonCellReadOnly(
    resolveAuthProfileDatabaseOptions(agentDir),
    "store",
  );
  return result.status === "readable" ? result.raw : null;
}

/** Reads the raw persisted runtime-state payload without coercing the schema. */
export function readPersistedAuthProfileStateRaw(
  agentDir?: string,
  database?: AuthProfileDatabase,
): unknown {
  if (database) {
    if (resolveAuthProfileDatabaseKind(agentDir, database) === "shared-state") {
      return parseJsonCell(readSharedAuthKvCell(database.db, SHARED_STATE_STATE_KEY));
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
  const result = inspectAuthProfileJsonCellReadOnly(
    resolveAuthProfileDatabaseOptions(agentDir),
    "state",
  );
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
      writeSharedAuthKvCell(target.db, SHARED_STORE_STATE_KEY, JSON.stringify(payload));
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
    if (databaseKind === "shared-state") {
      deleteSharedAuthKvCell(target.db, SHARED_STORE_STATE_KEY);
      return;
    }
    executeSqliteQuerySync(
      target.db,
      getAgentAuthProfileKysely(target.db)
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
      if (!payload) {
        deleteSharedAuthKvCell(target.db, SHARED_STATE_STATE_KEY);
        return;
      }
      writeSharedAuthKvCell(target.db, SHARED_STATE_STATE_KEY, JSON.stringify(payload));
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
  operation: (database: AuthProfileDatabase, owner: PreparedAuthProfileStoreOwner) => T,
  options: {
    env?: NodeJS.ProcessEnv;
    sharedStoreWrite?: boolean;
    stateDir?: string;
  } = {},
): T {
  const env = {
    ...(options.env ?? process.env),
    ...(!options.env && options.stateDir
      ? { OPENCLAW_STATE_DIR: options.stateDir, OPENCLAW_AGENT_DIR: undefined }
      : {}),
  };
  const sharedStoreWrite = prepareFreshSharedAuthStoreWrite({
    agentDir,
    allowExplicitMain: options.sharedStoreWrite === true,
    env,
  });
  const databaseTarget = resolveAuthProfileDatabaseOptions(
    sharedStoreWrite ? undefined : agentDir,
    env,
  );
  // Shared-owner discovery may inspect another database; complete it before BEGIN.
  const sharedOwner = prepareAuthProfileSharedOwner(env);
  if (databaseTarget.kind === "agent") {
    return runOpenClawAgentWriteTransaction((database) => {
      const previous = authProfileTransactions.get(database);
      const context = previous ?? {
        owner: { ...sharedOwner, databasePath: database.path },
        publications: [],
      };
      authProfileTransactions.set(database, context);
      try {
        return operation(database, context.owner);
      } finally {
        if (!previous) {
          authProfileTransactions.delete(database);
        }
      }
    }, databaseTarget);
  }

  const database = openOpenClawStateDatabase({ env, path: databaseTarget.path });
  const enteredNestedTransaction = database.db.isTransaction;
  const previous = authProfileTransactions.get(database);
  const context = previous ?? {
    owner: { ...sharedOwner, databasePath: database.path },
    publications: [],
  };
  const publicationStart = context.publications.length;
  if (!enteredNestedTransaction) {
    authProfileTransactions.set(database, context);
  }
  let result: T;
  try {
    const owner = context.owner;
    result = runOpenClawStateWriteTransaction((transaction) => operation(transaction, owner), {
      env,
      database,
    });
  } catch (error) {
    context.publications.splice(publicationStart);
    throw error;
  } finally {
    if (!enteredNestedTransaction) {
      authProfileTransactions.delete(database);
    }
  }
  if (!enteredNestedTransaction) {
    for (const publish of context.publications) {
      publish();
    }
  }
  return result;
}
