import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hasErrnoCode } from "../../infra/errno.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { writeConfigMachineState } from "../../state/config-machine-state.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { resolveUserPath } from "../../utils.js";
import { listLegacyAuthProfileSources } from "./legacy-source-files.js";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  SHARED_AUTH_STORE_STATE_KEY,
  type SharedAuthStoreOwnership,
} from "./path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";

const PRIMARY_ROW_KEY = "primary";
const SHARED_AUTH_STORE_MIGRATION_KIND = "shared-auth-store-state-db";

// Ownership objects are process-stable per state root. Doctor replaces the cached object
// after relocation, so legacy inspection is memoized only for that ownership generation.
const inspectedLegacySharedAuthOwnerships = new WeakSet<SharedAuthStoreOwnership>();

type SourceAuthDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
type SharedAuthMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "migration_sources">;

export type SharedAuthLegacyStoreRow = { store_json: string; updated_at: number };
export type SharedAuthLegacyStateRow = { state_json: string; updated_at: number };
export type SharedAuthLegacyRows = {
  store: SharedAuthLegacyStoreRow | null;
  state: SharedAuthLegacyStateRow | null;
};

export class SharedAuthStoreSourceInspectionError extends Error {
  readonly code = "SHARED_AUTH_STORE_SOURCE_UNREADABLE" as const;
  readonly action = "openclaw doctor --fix" as const;
  readonly sourcePath: string;

  constructor(sourcePath: string, operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot ${operation} legacy shared auth database ${sourcePath}: ${detail}`, { cause });
    this.name = "SharedAuthStoreSourceInspectionError";
    this.sourcePath = sourcePath;
  }
}

export function inspectSharedAuthLegacySourceFile(
  sourcePath: string,
): { status: "missing" } | { status: "present"; size: number } {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(sourcePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { status: "missing" };
    }
    throw new SharedAuthStoreSourceInspectionError(sourcePath, "inspect", error);
  }
  let target = entry;
  if (entry.isSymbolicLink()) {
    try {
      target = fs.statSync(sourcePath);
    } catch (error) {
      throw new SharedAuthStoreSourceInspectionError(sourcePath, "resolve", error);
    }
  }
  if (!target.isFile()) {
    throw new SharedAuthStoreSourceInspectionError(
      sourcePath,
      "open",
      new Error("path is not a regular file"),
    );
  }
  return { status: "present", size: target.size };
}

export function readSharedAuthLegacyRowsFromDatabase(database: DatabaseSync): SharedAuthLegacyRows {
  const db = getNodeSqliteKysely<SourceAuthDatabase>(database);
  const store = tableExists(database, "auth_profile_store")
    ? (executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("auth_profile_store")
          .select(["store_json", "updated_at"])
          .where("store_key", "=", PRIMARY_ROW_KEY),
      ) ?? null)
    : null;
  const state = tableExists(database, "auth_profile_state")
    ? (executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("auth_profile_state")
          .select(["state_json", "updated_at"])
          .where("state_key", "=", PRIMARY_ROW_KEY),
      ) ?? null)
    : null;
  return { store, state };
}

export function inspectSharedAuthLegacyRowsReadOnly(sourcePath: string): SharedAuthLegacyRows {
  if (inspectSharedAuthLegacySourceFile(sourcePath).status === "missing") {
    return { store: null, state: null };
  }
  let database: DatabaseSync;
  try {
    database = openNodeSqliteDatabase(sourcePath, { readOnly: true });
  } catch (error) {
    throw new SharedAuthStoreSourceInspectionError(sourcePath, "open", error);
  }
  try {
    return readSharedAuthLegacyRowsFromDatabase(database);
  } catch (error) {
    throw new SharedAuthStoreSourceInspectionError(sourcePath, "read", error);
  } finally {
    database.close();
  }
}

export function hasPendingSharedAuthCleanup(env: NodeJS.ProcessEnv, sourcePath: string): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db: database }) => {
        const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
        const row = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("migration_sources")
            .select("source_key")
            .where("migration_kind", "=", SHARED_AUTH_STORE_MIGRATION_KIND)
            .where("source_path", "=", sourcePath)
            .where("removed_source", "=", 0)
            .limit(1),
        );
        return Boolean(row);
      },
      { env },
    ) ?? false
  );
}

function initializeFreshSharedAuthStore(env: NodeJS.ProcessEnv): void {
  const ownership = resolveSharedAuthStoreOwnership(env);
  if (ownership.location === "state-db" || inspectedLegacySharedAuthOwnerships.has(ownership)) {
    return;
  }
  const sourcePath = path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite");
  try {
    if (listLegacyAuthProfileSources({ env }).length > 0) {
      inspectedLegacySharedAuthOwnerships.add(ownership);
      return;
    }
    const rows = inspectSharedAuthLegacyRowsReadOnly(sourcePath);
    if (rows.store || rows.state || hasPendingSharedAuthCleanup(env, sourcePath)) {
      inspectedLegacySharedAuthOwnerships.add(ownership);
      return;
    }
  } catch {
    // Doctor owns unreadable or partially migrated legacy state; never infer past it.
    inspectedLegacySharedAuthOwnerships.add(ownership);
    return;
  }
  writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" }, { env });
  noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
}

export function prepareFreshSharedAuthStoreWrite(params: {
  agentDir: string | undefined;
  allowExplicitMain: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  // A main-agent credential is shared; explicit main writes must follow the shared target.
  // On legacy roots both routes already resolve to the same file, so redirecting is a no-op.
  const isSharedWrite =
    params.agentDir === undefined ||
    (params.allowExplicitMain &&
      path.resolve(resolveUserPath(params.agentDir, params.env)) ===
        path.resolve(resolveSharedMainAuthAgentDir(params.env)));
  if (isSharedWrite) {
    initializeFreshSharedAuthStore(params.env);
  }
  return isSharedWrite;
}
