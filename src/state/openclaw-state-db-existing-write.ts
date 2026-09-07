import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import { assertSupportedStateSchemaVersion } from "./openclaw-state-db-schema-version.js";
import {
  runCoordinatedStateTransaction,
  withSharedStateWriteCoordinator,
} from "./openclaw-state-db-write-coordination.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  assertOpenClawStateWriteAllowed,
  runWithOpenClawStateWriteAccess,
} from "./openclaw-state-ownership.js";

/** Validate only the stable storage subset used by an existing-schema owner.
 * This read neither repairs nor grants write authority; callers retain their
 * actual handle, generation, lease and publication checks. */
export function assertExistingOpenClawStateSchema(
  db: DatabaseSync,
  pathname: string,
  schemaSql: string,
): number {
  const version = assertSupportedStateSchemaVersion(db, pathname);
  assertOpenClawStateDatabaseOwner(db, { pathname });
  const metadata = db
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'")
    .get();
  if (version < 1 || metadata?.schema_version !== version) {
    throw new Error("Existing-state schema metadata is inconsistent.");
  }
  assertSqliteIntegrity(db, pathname);
  assertSqliteSchemaContains(db, pathname, schemaSql);
  return version;
}

/** A synchronous write to an already-compatible, caller-owned schema subset.
 * No bootstrap, schema repair, journal-mode setup, cached publication or WAL timer.
 * The real handle and write coordinators cover open, transaction, and close.
 */
export function runExistingOpenClawStateWriteTransaction<T>(
  operation: (database: { db: DatabaseSync; path: string }) => T,
  options: OpenClawStateDatabaseOptions,
  contract: { schemaSql: string; operationLabel: string; busyTimeoutMs?: number },
): T {
  if (options.database || options.readOnly) {
    throw new Error("Existing-state writes require their own tracked writable connection.");
  }
  const env = options.env ?? process.env;
  const busyTimeoutMs = contract.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS;
  const pathname = path.resolve(options.path ?? resolveOpenClawStateSqlitePath(env));
  const original = fs.lstatSync(pathname);
  if (!original.isFile()) {
    throw new Error("Existing-state write requires a regular database file.");
  }
  const assertSameFile = () => {
    const current = fs.lstatSync(pathname);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("Existing-state database generation changed.");
    }
  };
  return withSharedStateWriteCoordinator({ databasePath: pathname, busyTimeoutMs }, () =>
    runWithOpenClawStateWriteAccess(
      { databasePath: pathname, env, busyTimeoutMs },
      contract.operationLabel,
      () => {
        assertSameFile();
        openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
        const db = openTrackedStateDatabase(pathname, { existingOnly: true });
        try {
          setSqliteBusyTimeout(db, busyTimeoutMs);
          return runCoordinatedStateTransaction(
            db,
            () => {
              assertSameFile();
              assertOpenClawStateWriteAllowed({ database: db, databasePath: pathname, env });
              const version = assertExistingOpenClawStateSchema(db, pathname, contract.schemaSql);
              const schemaVersion = db.prepare("PRAGMA schema_version").get()?.schema_version;
              const result = operation({ db, path: pathname });
              assertSameFile();
              if (
                readSqliteUserVersion(db) !== version ||
                db.prepare("PRAGMA schema_version").get()?.schema_version !== schemaVersion
              ) {
                throw new Error("Existing-state transaction cannot migrate schema.");
              }
              return result;
            },
            {
              busyTimeoutMs,
              databaseLabel: pathname,
              operationLabel: contract.operationLabel,
            },
          );
        } finally {
          clearNodeSqliteKyselyCacheForDatabase(db);
          closeTrackedStateDatabase(db);
        }
      },
    ),
  );
}
