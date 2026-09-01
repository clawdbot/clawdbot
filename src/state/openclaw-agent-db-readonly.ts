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

type OpenClawAgentReadOnlyDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
};

type OpenClawAgentDatabaseReadOnlyResult<T> =
  | { found: true; value: T }
  | { found: false; reason: "database-missing" | "schema-missing" | "table-missing" };

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

/** Read agent state without creating, registering, migrating, or joining its writable lifecycle. */
export function withOpenClawAgentDatabaseReadOnly<T>(
  operation: (database: OpenClawAgentReadOnlyDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  behavior: { throwOnMissingTable?: boolean; allowExtension?: boolean } = {},
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
  const opened = behavior.allowExtension
    ? undefined
    : findOpenAgentDatabase({ ...options, agentId });
  const reusable = opened && !opened.db.isTransaction ? opened : undefined;
  if (!reusable && !fs.existsSync(pathname)) {
    return { found: false, reason: "database-missing" };
  }
  const database = reusable ?? {
    agentId,
    db: openNodeSqliteDatabase(pathname, {
      readOnly: true,
      ...(behavior.allowExtension ? { allowExtension: true } : {}),
    }),
    path: pathname,
  };
  const { db } = database;
  try {
    if (!reusable) {
      db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    }
    // Share only this admission's fresh value; a later read must check again.
    const userVersion = assertSupportedAgentSchemaVersion(db, pathname);
    assertCanonicalAgentPersistenceVersion(db, pathname, userVersion);
    if (!reusable) {
      const schemaMeta = readExistingAgentSchemaMeta(db);
      if (!schemaMeta) {
        return { found: false, reason: "schema-missing" };
      }
      assertExistingAgentSchemaOwner(schemaMeta, agentId, pathname);
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
    if (!reusable) {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    }
  }
}
