import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

export type OpenClawAgentReadOnlyDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
};

type OpenClawAgentDatabaseReadOnlyResult<T> =
  | { found: true; value: T }
  | { found: false; reason: "database-missing" | "schema-missing" | "table-missing" };

export type OpenClawAgentReadOnlyDatabaseHandle = OpenClawAgentReadOnlyDatabase & {
  close: () => void;
};

export type OpenClawAgentDatabaseReadOnlyOpenResult =
  | { found: true; database: OpenClawAgentReadOnlyDatabaseHandle }
  | { found: false; reason: "database-missing" | "schema-missing" };

type OpenClawAgentDatabaseReadOnlyBehavior = {
  throwOnMissingTable?: boolean;
  allowExtension?: boolean;
};

type ReadOnlyFileIdentity = { dev: bigint; ino: bigint };
type ScopedReadOnlyConnection = {
  database: OpenClawAgentReadOnlyDatabaseHandle;
  identity: ReadOnlyFileIdentity;
  allowExtension: boolean;
};
type ReadOnlyScope = { active: boolean; connection?: ScopedReadOnlyConnection };

function readOnlyFileIdentity(pathname: string): ReadOnlyFileIdentity | undefined {
  try {
    const { dev, ino } = fs.statSync(pathname, { bigint: true });
    return { dev, ino };
  } catch {
    // A failed probe disables reuse; ordinary admission still owns errors and misses.
    return undefined;
  }
}

function sameReadOnlyFile(
  a: ReadOnlyFileIdentity | undefined,
  b: ReadOnlyFileIdentity | undefined,
) {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

function closeReadOnlyScopeConnection(scope: ReadOnlyScope | undefined) {
  const connection = scope?.connection;
  if (scope) {
    scope.connection = undefined;
  }
  connection?.database.close();
}

function hasReadableAgentSchema({ db, agentId, path: pathname }: OpenClawAgentReadOnlyDatabase) {
  const userVersion = assertSupportedAgentSchemaVersion(db, pathname);
  assertCanonicalAgentPersistenceVersion(db, pathname, userVersion);
  const schemaMeta = readExistingAgentSchemaMeta(db);
  if (!schemaMeta) {
    return false;
  }
  assertExistingAgentSchemaOwner(schemaMeta, agentId, pathname);
  return true;
}

/**
 * Look up a process-held handle without adopting writer-side failures.
 *
 * Read-only reads are meant to survive a latched open failure or an ownership
 * mismatch that only the writable lifecycle cares about; those callers fall
 * back to a fresh connection, which reports the precise reason.
 */
function findOpenAgentDatabase(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase | undefined {
  try {
    return getOpenClawAgentDatabaseIfOpen(options);
  } catch {
    return undefined;
  }
}

/** Open one existing agent database without creating, registering, migrating, or adopting it. */
export function openOpenClawAgentDatabaseReadOnly(
  options: OpenClawAgentDatabaseOptions,
  behavior: Pick<OpenClawAgentDatabaseReadOnlyBehavior, "allowExtension"> = {},
): OpenClawAgentDatabaseReadOnlyOpenResult {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  if (isIncognitoOpenClawAgentSqlitePath(pathname, { agentId, env: options.env })) {
    return { found: false, reason: "database-missing" };
  }
  if (!fs.existsSync(pathname)) {
    return { found: false, reason: "database-missing" };
  }
  const db = openNodeSqliteDatabase(pathname, {
    readOnly: true,
    ...(behavior.allowExtension ? { allowExtension: true } : {}),
  });
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  };
  try {
    db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    if (!hasReadableAgentSchema({ db, agentId, path: pathname })) {
      close();
      return { found: false, reason: "schema-missing" };
    }
    return { found: true, database: { agentId, db, path: pathname, close } };
  } catch (error) {
    close();
    throw error;
  }
}

/** Read agent state without creating, registering, migrating, or joining its writable lifecycle. */
export function withOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  behavior: OpenClawAgentDatabaseReadOnlyBehavior = {},
): OpenClawAgentDatabaseReadOnlyResult<T> {
  return readOpenClawAgentDatabaseReadOnly(operation, options, behavior);
}

/** Reuse one fresh connection synchronously; every logical read still queries current rows. */
export function withOpenClawAgentDatabaseReadOnlyScope<T>(
  operation: (read: typeof withOpenClawAgentDatabaseReadOnly) => T,
): T {
  const scope: ReadOnlyScope = { active: true };
  const read: typeof withOpenClawAgentDatabaseReadOnly = (readOperation, options, behavior) => {
    if (!scope.active) {
      throw new Error("Read-only agent database scope has closed.");
    }
    return readOpenClawAgentDatabaseReadOnly(readOperation, options, behavior, scope);
  };
  try {
    return operation(read);
  } finally {
    scope.active = false;
    closeReadOnlyScopeConnection(scope);
  }
}

function readOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  behavior: OpenClawAgentDatabaseReadOnlyBehavior = {},
  scope?: ReadOnlyScope,
): OpenClawAgentDatabaseReadOnlyResult<T> {
  // Detach an idle connection so a reentrant read cannot close its active caller.
  let retained = scope?.connection;
  if (scope) {
    scope.connection = undefined;
  }
  let fresh: OpenClawAgentDatabaseReadOnlyOpenResult | undefined;
  let identity: ReadOnlyFileIdentity | undefined;
  let succeeded = false;
  try {
    const agentId = normalizeAgentId(options.agentId);
    const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
    const incognito = isIncognitoOpenClawAgentSqlitePath(pathname, { agentId, env: options.env });
    const processOpened =
      incognito || behavior.allowExtension
        ? undefined
        : findOpenAgentDatabase({ ...options, agentId });
    const reusable = processOpened && !processOpened.db.isTransaction ? processOpened : undefined;
    if (
      retained &&
      (incognito ||
        reusable ||
        retained.database.agentId !== agentId ||
        retained.database.path !== pathname ||
        retained.allowExtension !== Boolean(behavior.allowExtension) ||
        retained.database.db.isTransaction ||
        !sameReadOnlyFile(retained.identity, readOnlyFileIdentity(pathname)))
    ) {
      const previous = retained;
      retained = undefined;
      previous.database.close();
    }
    if (incognito) {
      // Read-only misses must not create process-lifetime handles; only creation and
      // write paths may materialize the process-held incognito database.
      const database = getOpenClawAgentDatabaseIfOpen({ ...options, agentId });
      if (database && behavior.allowExtension) {
        throw new Error(
          "Extension-capable read-only access is unavailable for incognito databases.",
        );
      }
      const result: OpenClawAgentDatabaseReadOnlyResult<T> = database
        ? { found: true, value: operation(database) }
        : { found: false, reason: "database-missing" };
      succeeded = result.found;
      return result;
    }
    // Borrow only outside a transaction so readers see committed rows.
    // The writer owns reused handles; this call closes only fresh connections.
    const before = scope && !reusable && !retained ? readOnlyFileIdentity(pathname) : undefined;
    fresh = reusable
      ? undefined
      : retained
        ? { found: true, database: retained.database }
        : openOpenClawAgentDatabaseReadOnly({ ...options, agentId }, behavior);
    if (retained) {
      identity = retained.identity;
    } else if (scope && fresh?.found) {
      // These pathname probes are not SQLite-FD identity or ABA proof. A changed
      // initial admission serves this read once, but is never retained or replayed.
      const after = readOnlyFileIdentity(pathname);
      if (sameReadOnlyFile(before, after)) {
        identity = after;
      }
    }
    if (fresh && !fresh.found) {
      return fresh;
    }
    const database = reusable ?? fresh!.database;
    const { db } = database;
    if (retained && !hasReadableAgentSchema(database)) {
      return { found: false, reason: "schema-missing" };
    }
    if (reusable) {
      // Share only this admission's fresh value; a later read must check again.
      const userVersion = assertSupportedAgentSchemaVersion(db, pathname);
      assertCanonicalAgentPersistenceVersion(db, pathname, userVersion);
    }
    try {
      const value = operation(database);
      succeeded = true;
      return { found: true, value };
    } catch (error) {
      if (
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
        /\bno such table:/iu.test(error.message) &&
        !behavior.throwOnMissingTable
      ) {
        return { found: false, reason: "table-missing" };
      }
      throw error;
    }
  } finally {
    try {
      const owned = fresh?.found ? fresh.database : retained?.database;
      if (owned) {
        if (scope?.active && succeeded && identity && !owned.db.isTransaction) {
          closeReadOnlyScopeConnection(scope);
          scope.connection = {
            database: owned,
            identity,
            allowExtension: Boolean(behavior.allowExtension),
          };
        } else {
          owned.close();
        }
      }
    } finally {
      if (!succeeded) {
        closeReadOnlyScopeConnection(scope);
      }
    }
  }
}
