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
    const userVersion = assertSupportedAgentSchemaVersion(db, pathname);
    assertCanonicalAgentPersistenceVersion(db, pathname, userVersion);
    const schemaMeta = readExistingAgentSchemaMeta(db);
    if (!schemaMeta) {
      close();
      return { found: false, reason: "schema-missing" };
    }
    assertExistingAgentSchemaOwner(schemaMeta, agentId, pathname);
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
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  if (isIncognitoOpenClawAgentSqlitePath(pathname, { agentId, env: options.env })) {
    // Read-only misses must not create process-lifetime handles; only creation and
    // write paths may materialize the process-held incognito database.
    const database = getOpenClawAgentDatabaseIfOpen({ ...options, agentId });
    if (database && behavior.allowExtension) {
      throw new Error("Extension-capable read-only access is unavailable for incognito databases.");
    }
    return database
      ? { found: true, value: operation(database) }
      : { found: false, reason: "database-missing" };
  }
  // Borrow only outside a transaction so readers see committed rows.
  // The writer owns reused handles; this call closes only fresh connections.
  const processOpened = behavior.allowExtension
    ? undefined
    : findOpenAgentDatabase({ ...options, agentId });
  const reusable = processOpened && !processOpened.db.isTransaction ? processOpened : undefined;
  const fresh = reusable
    ? undefined
    : openOpenClawAgentDatabaseReadOnly({ ...options, agentId }, behavior);
  if (fresh && !fresh.found) {
    return fresh;
  }
  const database = reusable ?? fresh!.database;
  const { db } = database;
  try {
    if (reusable) {
      // Share only this admission's fresh value; a later read must check again.
      const userVersion = assertSupportedAgentSchemaVersion(db, pathname);
      assertCanonicalAgentPersistenceVersion(db, pathname, userVersion);
    }
    try {
      return { found: true, value: operation(database) };
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
    if (fresh?.found) {
      fresh.database.close();
    }
  }
}
